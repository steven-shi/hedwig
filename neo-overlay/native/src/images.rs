use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use wechat_protocol::media::{CdnClient, CdnConfig, MediaDescriptor, MediaQuality};

const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024;

fn aes_key(value: &str) -> Option<Vec<u8>> {
    let raw = value.as_bytes();
    if raw.len() != 32 || !raw.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    (0..32)
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect()
}

pub(super) fn descriptor(xml: &str) -> Option<MediaDescriptor> {
    if xml.len() > 24 * 1024 {
        return None;
    }
    let document = roxmltree::Document::parse(xml.trim()).ok()?;
    let root = document.root_element();
    let img = match root.tag_name().name() {
        "img" => root,
        "msg" => root.children().find(|n| n.has_tag_name("img"))?,
        _ => return None,
    };
    let variants = [
        (MediaQuality::Standard, "cdnmidimgurl", "length", "aeskey"),
        (MediaQuality::Original, "cdnbigimgurl", "hdlength", "aeskey"),
        (MediaQuality::Thumbnail, "cdnthumburl", "cdnthumblength", "cdnthumbaeskey"),
    ];
    variants.into_iter().find_map(|(quality, file_attr, size_attr, key_attr)| {
        let file_id = img.attribute(file_attr)?;
        if file_id.is_empty() || file_id.len() > 8192 || file_id.chars().any(char::is_control) {
            return None;
        }
        let expected_bytes = img.attribute(size_attr)?.parse::<u64>().ok()?;
        if !(1..=MAX_IMAGE_BYTES).contains(&expected_bytes) {
            return None;
        }
        let key = img.attribute(key_attr).or_else(|| img.attribute("aeskey"))?;
        Some(MediaDescriptor {
            file_id: file_id.to_owned(),
            aes_key: aes_key(key)?,
            quality,
            expected_bytes: Some(expected_bytes),
            expected_md5: None,
            strict_size: false,
            expires_at: None,
        })
    })
}

fn mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

pub(super) fn download(config: CdnConfig, descriptor: MediaDescriptor) -> Result<Value> {
    let started = Instant::now();
    let client = CdnClient::new(config, Duration::from_secs(3))?;
    let media = client.download_with_progress(&descriptor, |position, total| {
        // The progress values include encryption padding.
        ensure!(position <= MAX_IMAGE_BYTES + 16 && total.unwrap_or(0) <= MAX_IMAGE_BYTES + 16, "Image too large");
        ensure!(started.elapsed() <= Duration::from_secs(12), "Image download timed out");
        Ok(())
    })?;
    ensure!(media.bytes.len() as u64 <= MAX_IMAGE_BYTES, "Image too large");
    let mime = mime_type(&media.bytes).context("Unsupported image format")?;
    Ok(json!({ "mimeType": mime, "base64": STANDARD.encode(&media.bytes) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_sizes_select_a_bounded_variant_and_reject_invalid_metadata() {
        let xml = r#"<msg><img cdnmidimgurl="standard" length="99999999" cdnthumburl="thumbnail" cdnthumblength="120"
            aeskey="00000000000000000000000000000000" cdnthumbaeskey="11111111111111111111111111111111"/></msg>"#;
        let media = descriptor(xml).unwrap();
        assert_eq!(media.quality, MediaQuality::Thumbnail);
        assert_eq!(media.aes_key, vec![0x11; 16]);
        assert!(descriptor(&xml.replace("cdnthumblength=\"120\"", "cdnthumblength=\"99999999\"")).is_none());
        assert!(descriptor(&xml.replace("11111111111111111111111111111111", "invalid")).is_none());
        assert!(descriptor(&format!("<!DOCTYPE msg>{xml}")).is_none());
    }
}
