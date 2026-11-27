use super::NativeClient;
use crate::{protobuf as p, wire, AccountState, DeviceProfile};
use anyhow::{anyhow, ensure, Result};
use reqwest::Url;
use roxmltree::{Document, Node};
use serde::{Serialize, Serializer};
use std::{cmp::Reverse, collections::HashSet, str};

const TIMELINE_CGI: u16 = 211;
const TIMELINE_PATH: &str = "/cgi-bin/micromsg-bin/mmsnstimeline";
const LIKE_CGI: u16 = 213;
const LIKE_PATH: &str = "/cgi-bin/micromsg-bin/mmsnscomment";
const MAX_POSTS: usize = 10;

#[derive(Serialize)]
pub struct MomentsPost {
    #[serde(serialize_with = "serialize_post_id")]
    pub id: u64,
    pub author_id: Option<String>,
    pub nickname: Option<String>,
    pub created_at: u64,
    pub text: Option<String>,
    pub images: Vec<MomentsPhoto>,
    pub liked: Option<bool>,
}

#[derive(Serialize)]
pub struct MomentsPhoto {
    pub media_id: Option<String>,
    pub original_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub protected_media: bool,
}

fn serialize_post_id<S: Serializer>(id: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(id)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MomentsLikeResult {
    AlreadyLiked,
    Confirmed,
    AcceptedUnverified,
    NotOnHomepage,
    UnknownLikeState,
    MissingAccountName,
    Rejected(i32),
    OutcomeUnknown,
}

impl NativeClient {
    /// Read at most ten posts from a fresh homepage request for the signed-in account.
    pub async fn read_moments_latest(&self) -> Result<Vec<MomentsPost>> {
        self.account_request(|transport, state, _| transport.moments_homepage(state))
            .await
    }

    /// Check one exact post ID on the current homepage before submitting a like once.
    pub async fn like_moments_if_needed(&self, post_id: u64) -> Result<MomentsLikeResult> {
        self.account_request(move |transport, state, _| {
            let posts = transport.moments_homepage(state)?;
            let author = match like_target(&posts, post_id) {
                Ok(author) => author,
                Err(outcome) => return Ok(outcome),
            };
            let own_id = state.own_username.clone();
            let own_name = posts
                .iter()
                .find(|post| {
                    post.author_id.as_deref() == Some(own_id.as_str()) && post.nickname.is_some()
                })
                .and_then(|post| post.nickname.clone())
                .or_else(|| {
                    transport
                        .lookup_contacts_snapshot(state, std::slice::from_ref(&own_id))
                        .ok()?
                        .contacts
                        .into_iter()
                        .find(|contact| contact.username == own_id)?
                        .nickname
                });
            let Some(own_name) = own_name.filter(|name| !name.trim().is_empty()) else {
                return Ok(MomentsLikeResult::MissingAccountName);
            };
            let base = wire::base_request(&state.device, state.uin, 0)?;
            let request = encode_like(
                &base,
                post_id,
                author,
                &own_id,
                &own_name,
                wire::unix_time()?,
            )?;
            let reply = transport
                .authenticated_rpc(state, LIKE_CGI, LIKE_PATH, &request)
                .ok()
                .and_then(|reply| p::decode(&reply).ok());
            let code = reply.as_ref().and_then(|reply| p::base_code(reply).ok());
            if let Some(code) = code.filter(|code| *code != 0) {
                return Ok(MomentsLikeResult::Rejected(code));
            }
            let confirmed = transport.moments_homepage(state).ok().is_some_and(|posts| {
                posts
                    .iter()
                    .any(|post| post.id == post_id && post.liked == Some(true))
            });
            Ok(match (confirmed, code == Some(0)) {
                (true, _) => MomentsLikeResult::Confirmed,
                (false, true) => MomentsLikeResult::AcceptedUnverified,
                (false, false) => MomentsLikeResult::OutcomeUnknown,
            })
        })
        .await
    }

    fn moments_homepage(&self, state: &mut AccountState) -> Result<Vec<MomentsPost>> {
        let request = encode_homepage(&state.device, state.uin)?;
        let reply = self
            .authenticated_rpc(state, TIMELINE_CGI, TIMELINE_PATH, &request)
            .map_err(|_| anyhow!("Moments homepage transport failed"))?;
        decode_homepage(&reply, &state.own_username)
    }
}

fn like_target(posts: &[MomentsPost], id: u64) -> Result<&str, MomentsLikeResult> {
    let post = posts
        .iter()
        .find(|post| post.id == id)
        .ok_or(MomentsLikeResult::NotOnHomepage)?;
    match post.liked {
        Some(true) => Err(MomentsLikeResult::AlreadyLiked),
        Some(false) => post
            .author_id
            .as_deref()
            .ok_or(MomentsLikeResult::UnknownLikeState),
        None => Err(MomentsLikeResult::UnknownLikeState),
    }
}

fn encode_like(
    base: &[u8],
    post_id: u64,
    author: &str,
    own_id: &str,
    nickname: &str,
    timestamp: u32,
) -> Result<Vec<u8>> {
    let action = p::message(&[
        p::bytes(1, own_id.as_bytes()),
        p::bytes(2, author.as_bytes()),
        p::bytes(3, nickname.as_bytes()),
        p::bytes(4, author.as_bytes()),
        p::uint(5, 1),
        p::uint(6, 0),
        p::uint(7, timestamp.into()),
        p::bytes(8, b""),
        p::uint(23, 0),
    ])?;
    let group = p::message(&[p::uint(1, post_id), p::bytes(3, &action)])?;
    let client_id = format!("sns_comment:{post_id}_{timestamp}_1");
    p::message(&[
        p::bytes(1, base),
        p::bytes(2, &group),
        p::bytes(3, client_id.as_bytes()),
    ])
}

fn encode_homepage(profile: &DeviceProfile, uin: u32) -> Result<Vec<u8>> {
    // Start at the head with an empty cached MD5 and no previous page cursor.
    p::message(&[
        p::bytes(1, &wire::base_request(profile, uin, 0)?),
        p::bytes(2, b""),
        p::uint(3, 0),
        p::uint(4, 0),
        p::uint(5, 0),
        p::uint(6, 0),
        p::bytes(7, &p::buffer(b"")),
        p::uint(8, 1),
    ])
}

fn decode_homepage(reply: &[u8], own_id: &str) -> Result<Vec<MomentsPost>> {
    let fields = p::decode(reply)?;
    let code = p::base_code(&fields)?;
    ensure!(code == 0, "Moments homepage rejected (code {code})");
    let items = fields.iter().filter(|field| field.number == 4);
    ensure!(
        items.clone().next().is_some() || p::scalar(&fields, 3).unwrap_or(0) == 0,
        "Moments homepage omitted the post list"
    );
    let mut posts = Vec::new();
    let mut invalid = 0;
    for item in items {
        match &item.value {
            p::Value::Bytes(object) => match decode_post(object, own_id) {
                Ok(Some(post)) => posts.push(post),
                Ok(None) => {}
                Err(_) => invalid += 1,
            },
            _ => invalid += 1,
        }
    }
    ensure!(
        invalid == 0 || !posts.is_empty(),
        "Moments homepage has no readable posts"
    );
    posts.sort_by_key(|post| Reverse((post.created_at, post.id)));
    let mut seen = HashSet::new();
    posts.retain(|post| seen.insert(post.id));
    posts.truncate(MAX_POSTS);
    Ok(posts)
}

fn decode_post(object: &[u8], own_id: &str) -> Result<Option<MomentsPost>> {
    let fields = p::decode(object)?;
    if matches!(p::optional(&fields, 24)?, Some(p::Value::Varint(1..))) {
        return Ok(None);
    }
    let id = p::scalar(&fields, 1)?;
    ensure!(id != 0, "Missing Moments post ID");

    let xml = p::optional_data(&fields, 5)?
        .and_then(|bytes| p::unbuffer(bytes).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok());
    let document = xml.as_deref().and_then(|xml| Document::parse(xml).ok());
    let timeline = document
        .as_ref()
        .map(Document::root_element)
        .filter(|node| node.has_tag_name("TimelineObject"));

    let created_at = p::scalar(&fields, 4)
        .ok()
        .filter(|time| *time > 0)
        .or_else(|| child_text(timeline?, "createTime")?.trim().parse().ok())
        .filter(|time| *time > 0)
        .ok_or_else(|| anyhow!("Missing Moments timestamp"))?;
    let author_id = proto_text(&fields, 2)
        .or_else(|| child_text(timeline?, "username").filter(|name| !name.trim().is_empty()));
    let text = timeline.map(|node| child_text(node, "contentDesc").unwrap_or_default());
    let images = timeline.map(parse_photos).unwrap_or_default();
    Ok(Some(MomentsPost {
        id,
        author_id,
        nickname: proto_text(&fields, 3),
        created_at,
        text,
        images,
        liked: like_state(&fields, own_id),
    }))
}

fn like_state(fields: &[p::Field], own_id: &str) -> Option<bool> {
    let flag = p::scalar(fields, 6).ok().map(|flag| flag != 0);
    if flag == Some(true) {
        return flag;
    }
    let own_like = !own_id.is_empty()
        && fields
            .iter()
            .filter(|field| field.number == 9)
            .any(|field| {
                let p::Value::Bytes(like) = &field.value else {
                    return false;
                };
                p::decode(like)
                    .ok()
                    .and_then(|like| proto_text(&like, 1))
                    .as_deref()
                    == Some(own_id)
            });
    if own_like {
        Some(true)
    } else {
        flag
    }
}

fn proto_text(fields: &[p::Field], number: u32) -> Option<String> {
    let bytes = p::optional_data(fields, number).ok()??;
    let text = str::from_utf8(bytes).ok()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|node| node.has_tag_name(name))
}

fn child_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    Some(
        child(node, name)?
            .children()
            .filter(Node::is_text)
            .filter_map(|node| node.text())
            .collect(),
    )
}

fn parse_photos(timeline: Node<'_, '_>) -> Vec<MomentsPhoto> {
    let list = child(timeline, "ContentObject").and_then(|node| child(node, "mediaList"));
    list.into_iter()
        .flat_map(|list| list.children())
        .filter(|node| node.has_tag_name("media"))
        .filter(|node| child_text(*node, "type").is_some_and(|kind| kind.trim() == "2"))
        .take(9)
        .map(|node| {
            let old_media_auth = ["key", "token"]
                .iter()
                .any(|name| child_text(node, name).is_some_and(|value| auth_value(&value)));
            let (original_url, original_protected) = photo_url(child(node, "url"), old_media_auth);
            let (thumbnail_url, thumbnail_protected) =
                photo_url(child(node, "thumb"), old_media_auth);
            MomentsPhoto {
                media_id: child_text(node, "id").filter(|id| !id.is_empty()),
                original_url,
                thumbnail_url,
                protected_media: old_media_auth || original_protected || thumbnail_protected,
            }
        })
        .collect()
}

fn auth_value(value: &str) -> bool {
    !matches!(value.trim(), "" | "0")
}

fn photo_url(node: Option<Node<'_, '_>>, media_auth: bool) -> (Option<String>, bool) {
    let Some(node) = node else {
        return (None, false);
    };
    if media_auth
        || ["key", "token", "enc_idx"]
            .iter()
            .any(|name| node.attribute(*name).is_some_and(auth_value))
    {
        return (None, true);
    }
    let Some(mut url) = node.text().and_then(|value| Url::parse(value.trim()).ok()) else {
        return (None, false);
    };
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return (None, true);
    }
    // Only follow direct image URLs on the Moments CDN. Keep other embeds inert.
    if !matches!(url.scheme(), "http" | "https")
        || !url
            .host_str()
            .is_some_and(|host| host.ends_with(".qpic.cn"))
        || !url.path().starts_with("/mmsns/")
        || url.port().is_some()
        || url.set_scheme("https").is_err()
    {
        return (None, false);
    }
    url.set_fragment(None);
    (Some(url.to_string()), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHOTO_XML: &str = r#"<TimelineObject>
        <username>fixture-xml-author</username><createTime>1700000042</createTime>
        <contentDesc><![CDATA[合成图]]>&amp; 狗</contentDesc>
        <ContentObject><mediaList>
            <media><id>7</id><type>2</type><url>http://mmsns.qpic.cn/mmsns/fixture/0</url>
                <thumb>https://shmmsns.qpic.cn/mmsns/fixture/150</thumb></media>
            <media><type>2</type><url token="fixture-token">https://mmsns.qpic.cn/mmsns/private/0</url></media>
            <media><type>2</type><url>https://example.test/mmsns/elsewhere/0</url></media>
            <media><type>6</type><thumb>https://mmsns.qpic.cn/mmsns/video/150</thumb></media>
        </mediaList></ContentObject>
    </TimelineObject>"#;

    fn item(id: u64, timestamp: u64, author: &str, xml: &str) -> Result<Vec<u8>> {
        Ok(p::bytes(
            4,
            &p::message(&[
                p::uint(1, id),
                p::bytes(2, author.as_bytes()),
                p::bytes(3, "测试昵称".as_bytes()),
                p::uint(4, timestamp),
                p::bytes(5, &p::buffer(xml.as_bytes())),
            ])?,
        ))
    }

    #[test]
    fn builds_a_fresh_homepage_request() -> Result<()> {
        let profile = DeviceProfile::generate("UnifiedPCLinux fixture".into())?;
        let request = p::decode(&encode_homepage(&profile, 0)?)?;
        assert!(!p::data(&request, 1)?.is_empty());
        assert_eq!(p::data(&request, 2)?, b"");
        for field in 3..=6 {
            assert_eq!(p::scalar(&request, field)?, 0);
        }
        assert!(p::unbuffer(p::data(&request, 7)?)?.is_empty());
        assert_eq!(p::scalar(&request, 8)?, 1);
        Ok(())
    }

    #[test]
    fn returns_ten_newest_unique_posts_with_exact_ids_and_photo_references() -> Result<()> {
        let latest = u64::MAX - 17;
        let mut fields = vec![p::bytes(1, &p::int32(1, 0)), p::uint(3, 13)];
        for id in 1..=11 {
            fields.push(item(
                id,
                1700000000 + id,
                "fixture-author",
                "<TimelineObject/>",
            )?);
        }
        fields.push(item(latest, 0, "", PHOTO_XML)?);
        fields.push(item(latest, 1700000000, "duplicate", "<TimelineObject/>")?);
        let posts = decode_homepage(&p::message(&fields)?, "self")?;
        assert_eq!(posts.len(), 10);
        let post = &posts[0];
        assert_eq!(post.id, latest);
        assert_eq!(post.author_id.as_deref(), Some("fixture-xml-author"));
        assert_eq!(post.nickname.as_deref(), Some("测试昵称"));
        assert_eq!(post.created_at, 1700000042);
        assert_eq!(post.text.as_deref(), Some("合成图& 狗"));
        assert_eq!(post.images.len(), 3);
        assert_eq!(
            post.images[0].original_url.as_deref(),
            Some("https://mmsns.qpic.cn/mmsns/fixture/0")
        );
        assert!(post.images[0].thumbnail_url.is_some());
        assert!(post.images[1].protected_media && post.images[1].original_url.is_none());
        assert!(post.images[2].original_url.is_none());
        assert_eq!(posts[9].id, 3);
        let json = serde_json::to_value(post)?;
        assert_eq!(json["id"].as_str(), Some(latest.to_string().as_str()));
        assert!(!json.to_string().contains("fixture-token"));
        Ok(())
    }

    #[test]
    fn keeps_outer_fields_when_xml_is_damaged() -> Result<()> {
        let reply = p::message(&[
            p::bytes(1, &p::int32(1, 0)),
            item(42, 1700000000, "fixture-author", "<TimelineObject broken")?,
        ])?;
        let posts = decode_homepage(&reply, "self")?;
        assert_eq!(posts[0].author_id.as_deref(), Some("fixture-author"));
        assert_eq!(posts[0].created_at, 1700000000);
        assert!(posts[0].text.is_none() && posts[0].images.is_empty());
        Ok(())
    }

    #[test]
    fn distinguishes_empty_homepage_from_rejection_and_unreadable_items() -> Result<()> {
        assert!(decode_homepage(&p::bytes(1, &p::int32(1, 0)), "self")?.is_empty());
        assert!(decode_homepage(&p::bytes(1, &p::int32(1, -1)), "self").is_err());
        let reply = p::message(&[p::bytes(1, &p::int32(1, 0)), p::bytes(4, b"\0")])?;
        assert!(decode_homepage(&reply, "self").is_err());
        Ok(())
    }

    #[test]
    fn skips_already_liked_or_unknown_posts() -> Result<()> {
        let other_like = p::bytes(9, &p::bytes(1, b"fixture-other"));
        let self_like = p::bytes(9, &p::bytes(1, b"fixture-self"));
        for (fields, expected) in [
            (vec![p::uint(6, 1)], Some(true)),
            (vec![p::uint(6, 0), self_like], Some(true)),
            (vec![p::uint(6, 0), other_like], Some(false)),
            (vec![], None),
        ] {
            let liked = like_state(&p::decode(&p::message(&fields)?)?, "fixture-self");
            assert_eq!(liked, expected);
            let posts = [MomentsPost {
                id: 42,
                author_id: Some("fixture-author".to_owned()),
                nickname: None,
                created_at: 1700000000,
                text: None,
                images: Vec::new(),
                liked,
            }];
            let action = match expected {
                Some(true) => Err(MomentsLikeResult::AlreadyLiked),
                Some(false) => Ok("fixture-author"),
                None => Err(MomentsLikeResult::UnknownLikeState),
            };
            assert_eq!(like_target(&posts, 42), action);
            assert_eq!(
                like_target(&posts, 99),
                Err(MomentsLikeResult::NotOnHomepage)
            );
        }
        Ok(())
    }

    #[test]
    fn encodes_one_like_for_the_full_post_id() -> Result<()> {
        let request = p::decode(&encode_like(
            b"base",
            u64::MAX,
            "author",
            "actor",
            "测试昵称",
            123,
        )?)?;
        assert_eq!(p::data(&request, 1)?, b"base");
        let group = p::decode(p::data(&request, 2)?)?;
        assert_eq!(p::scalar(&group, 1)?, u64::MAX);
        let action = p::decode(p::data(&group, 3)?)?;
        assert_eq!(p::data(&action, 1)?, b"actor");
        assert_eq!(p::data(&action, 2)?, b"author");
        assert_eq!(p::scalar(&action, 5)?, 1);
        assert_eq!(p::data(&action, 8)?, b"");
        assert_eq!(p::scalar(&action, 23)?, 0);
        Ok(())
    }
}
