//! Scoped Moments RPCs on the existing account request and transport.
use super::AccountRequest;
use crate::{protobuf as p, wire, DeviceProfile};
use anyhow::{ensure, Result};
use std::{cmp::Reverse, collections::HashSet, str};

pub struct MomentsCandidate {
    pub id: u64,
    pub author: Option<String>,
    pub nickname: Option<String>,
    pub timestamp: u64,
    pub liked: Option<bool>,
}

impl AccountRequest<'_> {
    pub fn moments_homepage(&mut self) -> Result<Vec<MomentsCandidate>> {
        self.admit()?;
        let request = encode_homepage(&self.state.device, self.state.uin)?;
        let reply = self.transport.authenticated_rpc(
            self.state,
            211,
            "/cgi-bin/micromsg-bin/mmsnstimeline",
            &request,
        )?;
        decode_homepage(&reply, &self.state.own_username)
    }

    pub fn submit_moments_like(&mut self, id: u64, author: &str, nickname: &str) -> Result<i32> {
        self.admit()?;
        let own = &self.state.own_username;
        ensure!(
            id != 0
                && !own.is_empty()
                && !author.is_empty()
                && own != author
                && !nickname.is_empty(),
            "Missing Moments like target"
        );
        let base = wire::base_request(&self.state.device, self.state.uin, 0)?;
        let request = encode_like(&base, id, author, own, nickname, wire::unix_time()?)?;
        let reply = self.transport.authenticated_rpc(
            self.state,
            213,
            "/cgi-bin/micromsg-bin/mmsnscomment",
            &request,
        )?;
        p::base_code(&p::decode(&reply)?)
    }
}

fn encode_homepage(profile: &DeviceProfile, uin: u32) -> Result<Vec<u8>> {
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

fn decode_homepage(reply: &[u8], own: &str) -> Result<Vec<MomentsCandidate>> {
    let fields = p::decode(reply)?;
    let code = p::base_code(&fields)?;
    ensure!(code == 0, "Moments homepage rejected");
    let mut seen = HashSet::new();
    let mut posts = Vec::new();
    let mut received = 0;
    for field in fields.iter().filter(|field| field.number == 4) {
        received += 1;
        let p::Value::Bytes(raw) = &field.value else {
            anyhow::bail!("Invalid Moments post")
        };
        let post = p::decode(raw)?;
        if matches!(p::optional(&post, 24)?, Some(p::Value::Varint(1..))) {
            continue;
        }
        let id = p::scalar(&post, 1)?;
        let timestamp = p::scalar(&post, 4)?;
        ensure!(
            id != 0 && timestamp > 0 && timestamp <= u64::from(u32::MAX) && seen.insert(id),
            "Invalid Moments identity"
        );
        posts.push(MomentsCandidate {
            id,
            timestamp,
            author: text(&post, 2),
            nickname: text(&post, 3),
            liked: like_state(&post, own),
        });
    }
    ensure!(
        received > 0 || p::scalar(&fields, 3).unwrap_or(0) == 0,
        "Missing Moments post list"
    );
    posts.sort_by_key(|post| Reverse((post.timestamp, post.id)));
    posts.truncate(10);
    Ok(posts)
}

fn text(fields: &[p::Field], number: u32) -> Option<String> {
    let value = str::from_utf8(p::optional_data(fields, number).ok()??)
        .ok()?
        .trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn like_state(fields: &[p::Field], own: &str) -> Option<bool> {
    let flag = p::scalar(fields, 6).ok().map(|flag| flag != 0);
    if flag == Some(true) {
        return flag;
    }
    let own_like = fields
        .iter()
        .filter(|field| field.number == 9)
        .any(|field| {
            let p::Value::Bytes(like) = &field.value else {
                return false;
            };
            p::decode(like)
                .ok()
                .and_then(|like| text(&like, 1))
                .as_deref()
                == Some(own)
        });
    if own_like {
        Some(true)
    } else {
        flag
    }
}

fn encode_like(
    base: &[u8],
    id: u64,
    author: &str,
    own: &str,
    nickname: &str,
    timestamp: u32,
) -> Result<Vec<u8>> {
    let action = p::message(&[
        p::bytes(1, own.as_bytes()),
        p::bytes(2, author.as_bytes()),
        p::bytes(3, nickname.as_bytes()),
        p::bytes(4, author.as_bytes()),
        p::uint(5, 1),
        p::uint(6, 0),
        p::uint(7, timestamp.into()),
        p::bytes(8, b""),
        p::uint(23, 0),
    ])?;
    let group = p::message(&[p::uint(1, id), p::bytes(3, &action)])?;
    let nonce = format!("sns_comment:{id}_{timestamp}_1");
    p::message(&[
        p::bytes(1, base),
        p::bytes(2, &group),
        p::bytes(3, nonce.as_bytes()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moments_decodes_like_status_for_ten_posts_in_one_response() -> Result<()> {
        let mut feed = vec![p::bytes(1, &p::int32(1, 0)), p::uint(3, 12)];
        for id in 1..=12 {
            let mut post = vec![
                p::uint(1, id),
                p::bytes(2, b"fixture-author"),
                p::uint(4, id),
            ];
            if id != 11 {
                post.push(p::uint(6, 0));
            }
            if id == 12 {
                post.push(p::bytes(9, &p::bytes(1, b"fixture-own")));
            }
            feed.push(p::bytes(4, &p::message(&post)?));
        }
        let posts = decode_homepage(&p::message(&feed)?, "fixture-own")?;
        assert_eq!(posts.len(), 10);
        assert_eq!((posts[0].id, posts[0].liked), (12, Some(true)));
        assert_eq!(posts[1].liked, None);
        assert_eq!(posts[2].liked, Some(false));
        assert_eq!(posts[9].id, 3);
        Ok(())
    }

    #[test]
    fn moments_encodes_exact_id_and_like_action() -> Result<()> {
        let request = p::decode(&encode_like(
            b"base",
            u64::MAX,
            "author",
            "own",
            "name",
            42,
        )?)?;
        let group = p::decode(p::data(&request, 2)?)?;
        let action = p::decode(p::data(&group, 3)?)?;
        assert_eq!(p::scalar(&group, 1)?, u64::MAX);
        assert_eq!(p::scalar(&action, 5)?, 1);
        assert_eq!(p::data(&action, 8)?, b"");
        assert_eq!(p::scalar(&action, 23)?, 0);
        Ok(())
    }
}
