use super::Session;
use anyhow::{Context, Result};
use serde_json::{json, Value};

pub(super) fn homepage(session: &mut Session) -> Result<Value> {
    session.moments.clear();
    let account = session.account.as_ref().context("No active session")?;
    let own = account.account_identity()?.own_username;
    let posts = account.request_blocking(|request| request.moments_homepage())?;
    let mut result = Vec::with_capacity(posts.len());
    for post in posts {
        let id = post.id.to_string();
        let is_self = post.author.as_deref().map(|author| author == own);
        if is_self == Some(true) {
            if let Some(nickname) = post.nickname {
                session.self_nickname = Some(nickname);
            }
        }
        if let (Some(false), Some(false), Some(author)) = (is_self, post.liked, post.author) {
            session.moments.insert(id.clone(), author);
        }
        result.push(json!({ "id": id, "createdAt": post.timestamp, "isSelf": is_self, "liked": post.liked }));
    }
    Ok(json!(result))
}

pub(super) fn like(session: &mut Session, id: &str) -> Result<Value> {
    let author = session
        .moments
        .remove(id)
        .context("No eligible Moments post")?;
    let id = id.parse::<u64>()?;
    let nickname = session
        .self_nickname
        .as_deref()
        .context("Missing account nickname")?;
    let account = session.account.as_ref().context("No active session")?;
    let code =
        account.request_blocking(|request| request.submit_moments_like(id, &author, nickname))?;
    Ok(match code {
        0 => json!({ "status": "accepted" }),
        code => json!({ "status": "rejected", "serviceCode": code }),
    })
}
