use anyhow::{anyhow, bail, Result};
use image::ImageFormat;
use reqwest::{blocking::Client, redirect::Policy};
use serde::Serialize;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use wechat_protocol::{
    is_retryable_login_poll_error, wire, DeviceProfile, LoginStatus, MomentsPhoto, MomentsPost,
    MomentsTrialReceipt, NativeClient, NativeOptions,
};

fn login(qr_path: &Path) -> Result<NativeClient> {
    let open = || anyhow!("Could not start the isolated login");
    let client = NativeClient::new(NativeOptions::default()).map_err(|_| open())?;
    let device = DeviceProfile::generate("UnifiedPCLinux aarch64".into()).map_err(|_| open())?;
    let mut attempt = client
        .start_qr_login(device, "Hedwig Moments Trial")
        .map_err(|_| open())?;
    let mut image = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(qr_path)?;
    image.write_all(&attempt.qr_png)?;
    drop(image);
    println!("QR_READY");
    let deadline = Instant::now() + Duration::from_secs(180);
    let outcome = loop {
        if Instant::now() >= deadline {
            break Err(anyhow!("QR expired"));
        }
        match client.poll_login_guarded(&mut attempt, deadline, || false) {
            Ok(LoginStatus::Approved) => {
                break client
                    .complete_login(&mut attempt)
                    .and_then(|state| NativeClient::from_account(state, NativeOptions::default()))
                    .map_err(|_| anyhow!("The new login could not be completed"));
            }
            Ok(LoginStatus::Pending | LoginStatus::Scanned) => {}
            Ok(_) => break Err(anyhow!("The test login was cancelled or expired")),
            Err(error) if is_retryable_login_poll_error(&error) => {}
            Err(_) => break Err(anyhow!("The test login could not be polled")),
        }
        thread::sleep(Duration::from_secs(2));
    };
    let _ = fs::remove_file(qr_path);
    outcome
}

enum Command {
    Publish,
    Read(PathBuf),
    Like(u64),
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let (qr_path, command) = match args.as_slice() {
        [mode] if mode == "--help" => {
            println!("moments_trial --read-latest NEW_QR_PNG NEW_OUTPUT_DIR");
            println!("moments_trial --submit-private NEW_QR_PNG");
            println!("moments_trial --like-if-needed POST_ID NEW_QR_PNG");
            return Ok(());
        }
        [mode, qr] if mode == "--submit-private" => (PathBuf::from(qr), Command::Publish),
        [mode, qr, output] if mode == "--read-latest" => {
            let output = PathBuf::from(output);
            DirBuilder::new().mode(0o700).create(&output)?;
            (PathBuf::from(qr), Command::Read(output))
        }
        [mode, post_id, qr] if mode == "--like-if-needed" => {
            let post_id = post_id
                .parse::<u64>()
                .ok()
                .filter(|id| *id != 0)
                .ok_or_else(|| anyhow!("Expected a nonzero decimal post ID"))?;
            (PathBuf::from(qr), Command::Like(post_id))
        }
        _ => bail!("Use --help for the list of commands"),
    };
    let client = tokio::task::spawn_blocking(move || login(&qr_path)).await??;
    println!("LOGIN_READY");
    match command {
        Command::Publish => submit_private(client).await,
        Command::Read(output) => {
            let result = client.read_moments_latest().await;
            let _ = client.shutdown().await;
            let posts = result?;
            let count = posts.len();
            let photos =
                tokio::task::spawn_blocking(move || save_timeline(&output, &posts)).await??;
            println!("TIMELINE_READY {count}; PHOTOS_SAVED {photos}");
            Ok(())
        }
        Command::Like(post_id) => {
            let result = client.like_moments_if_needed(post_id).await;
            let _ = client.shutdown().await;
            println!("LIKE_RESULT {:?}", result?);
            Ok(())
        }
    }
}

async fn submit_private(client: NativeClient) -> Result<()> {
    let created_at = wire::unix_time()?;
    let mut nonce = [0_u8; 16];
    openssl::rand::rand_bytes(&mut nonce)?;
    let text = format!("Hedwig 纯文字朋友圈测试 {created_at}");
    let result = client
        .submit_moments_trial(text, created_at, hex::encode(nonce))
        .await;
    let _ = client.shutdown().await;
    match result {
        Ok(MomentsTrialReceipt::Accepted(id)) => println!("POST_ACCEPTED {id}"),
        Ok(MomentsTrialReceipt::Rejected(code)) => bail!("POST_REJECTED {code}"),
        Err(_) => bail!("POST_OUTCOME_UNKNOWN; check the test account before any further action"),
    }
    Ok(())
}

#[derive(Serialize)]
struct TimelineExport<'a> {
    posts: &'a [MomentsPost],
    saved_images: Vec<SavedImage>,
}

#[derive(Serialize)]
struct SavedImage {
    post_id: String,
    image_index: usize,
    file: String,
    variant: &'static str,
}

fn save_timeline(output: &Path, posts: &[MomentsPost]) -> Result<usize> {
    let client = Client::builder().redirect(Policy::none()).build()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut saved_images = Vec::new();
    'download: for post in posts {
        for (index, photo) in post.images.iter().enumerate() {
            if Instant::now() >= deadline {
                break 'download;
            }
            if let Some((bytes, extension, variant)) = fetch_photo(&client, photo, deadline) {
                let image_index = index + 1;
                let file = format!("{}-{image_index}.{extension}", post.id);
                write_private(&output.join(&file), &bytes)?;
                saved_images.push(SavedImage {
                    post_id: post.id.to_string(),
                    image_index,
                    file,
                    variant,
                });
            }
        }
    }
    let count = saved_images.len();
    let manifest = serde_json::to_vec_pretty(&TimelineExport {
        posts,
        saved_images,
    })?;
    write_private(&output.join("timeline.json"), &manifest)?;
    Ok(count)
}

fn fetch_photo(
    client: &Client,
    photo: &MomentsPhoto,
    deadline: Instant,
) -> Option<(Vec<u8>, &'static str, &'static str)> {
    [
        (photo.original_url.as_deref(), "original"),
        (photo.thumbnail_url.as_deref(), "thumbnail"),
    ]
    .into_iter()
    .find_map(|(url, variant)| {
        let timeout = deadline
            .checked_duration_since(Instant::now())?
            .min(Duration::from_secs(5));
        let (bytes, extension) = download_photo(client, url?, timeout)?;
        Some((bytes, extension, variant))
    })
}

fn download_photo(
    client: &Client,
    url: &str,
    timeout: Duration,
) -> Option<(Vec<u8>, &'static str)> {
    const MAX_BYTES: u64 = 10 * 1024 * 1024;
    let response = client.get(url).timeout(timeout).send().ok()?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|len| len > MAX_BYTES)
    {
        return None;
    }
    let mut bytes = Vec::new();
    response.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let extension = match image::guess_format(&bytes).ok()? {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        _ => return None,
    };
    Some((bytes, extension))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, net::TcpListener, os::unix::fs::PermissionsExt};

    #[test]
    fn exports_a_thumbnail_when_the_original_is_not_an_image() -> Result<()> {
        let server = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://{}", server.local_addr()?);
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1).write_to(&mut png, ImageFormat::Png)?;
        let png = png.into_inner();
        let fixture = png.clone();
        let server = thread::spawn(move || -> std::io::Result<()> {
            for body in [b"not an image".as_slice(), fixture.as_slice()] {
                let (mut stream, _) = server.accept()?;
                let mut request = [0; 4096];
                let _ = stream.read(&mut request)?;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )?;
                stream.write_all(body)?;
            }
            Ok(())
        });
        let mut nonce = [0_u8; 16];
        openssl::rand::rand_bytes(&mut nonce)?;
        let output =
            std::env::temp_dir().join(format!("hedwig-moments-fixture-{}", hex::encode(nonce)));
        DirBuilder::new().mode(0o700).create(&output)?;
        let posts = [MomentsPost {
            id: 42,
            author_id: Some("fixture-author".to_owned()),
            nickname: None,
            created_at: 1700000000,
            text: Some("synthetic".to_owned()),
            liked: None,
            images: vec![MomentsPhoto {
                media_id: None,
                original_url: Some(format!("{base}/original")),
                thumbnail_url: Some(format!("{base}/thumbnail")),
                protected_media: false,
            }],
        }];
        assert_eq!(save_timeline(&output, &posts)?, 1);
        server.join().expect("fixture server joined")?;
        let manifest = output.join("timeline.json");
        let result: serde_json::Value = serde_json::from_slice(&fs::read(&manifest)?)?;
        assert_eq!(result["posts"][0]["id"], "42");
        assert_eq!(result["saved_images"][0]["variant"], "thumbnail");
        assert_eq!(result["saved_images"][0]["file"], "42-1.png");
        assert_eq!(fs::read(output.join("42-1.png"))?, png);
        assert_eq!(fs::metadata(manifest)?.permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(output)?;
        Ok(())
    }
}
