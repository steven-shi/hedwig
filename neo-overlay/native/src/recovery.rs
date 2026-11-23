use anyhow::Result;
use wechat_protocol::{is_session_rejected, AccountInterrupted, Service, ServiceRejected};

#[derive(Debug)]
struct SessionEnded;

impl std::fmt::Display for SessionEnded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WeChat rejected the session and its renewal")
    }
}

impl std::error::Error for SessionEnded {}

// Based on Puppet Neo ddfa5ec. Only read operations use this recovery path.
pub(super) fn recover<S, T>(
    session: &mut S,
    mut operation: impl FnMut(&mut S) -> Result<T>,
    mut renew: impl FnMut(&mut S) -> Result<()>,
    reconnect: impl Fn(&mut S),
) -> Result<T> {
    let mut reconnected = false;
    let mut renewed = false;
    loop {
        let error = match operation(session) {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if is_session_rejected(&error) {
            if renewed {
                return Err(error.context(SessionEnded));
            }
            renewed = true;
            if let Err(error) = renew(session) {
                let rejected = is_session_rejected(&error)
                    || ServiceRejected::find(&error)
                        .is_some_and(|reply| reply.service == Service::AutomaticAuthentication);
                reconnect(session);
                return Err(if rejected { error.context(SessionEnded) } else { error });
            }
        } else if reconnectable(&error) {
            // Drop the stale socket even when this call has used its retry.
            if reconnected {
                reconnect(session);
                return Err(error);
            }
            reconnected = true;
        } else {
            return Err(error);
        }
        reconnect(session);
    }
}

fn account_ended(error: &anyhow::Error) -> bool {
    matches!(
        AccountInterrupted::find(error),
        Some(AccountInterrupted::Stopped | AccountInterrupted::Transferred)
    )
}

fn reconnectable(error: &anyhow::Error) -> bool {
    ServiceRejected::find(error).is_none() && !account_ended(error)
}

// The Node bridge logs only this fixed category and an optional i32 service code.
pub(super) fn read_failure(error: &anyhow::Error) -> String {
    let rejection = ServiceRejected::find(error);
    let category = if error.is::<SessionEnded>() {
        "auth_required"
    } else if account_ended(error) {
        "account_interrupted"
    } else if rejection.is_some() {
        "service_rejected"
    } else {
        "read_unavailable"
    };
    let mut diagnostic = format!("NEO_READ:{category}");
    if let Some(reply) = rejection {
        diagnostic.push_str(&format!(":{}", reply.code));
    }
    diagnostic
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    #[test]
    fn each_read_can_reconnect_once_and_reuses_the_session() {
        let mut attempts = 0;
        let mut reconnects = 0;
        let result = recover(
            &mut reconnects,
            |_| {
                attempts += 1;
                if attempts == 1 { Err(anyhow!("connection reset")) } else { Ok("page") }
            },
            |_| panic!("network loss must not renew credentials"),
            |reconnects| *reconnects += 1,
        );
        assert_eq!(result.unwrap(), "page");
        assert_eq!((attempts, reconnects), (2, 1));
    }

    #[test]
    fn an_unavailable_read_releases_the_stale_socket_for_the_next_attempt() {
        let mut reconnects = 0;
        let error = recover(
            &mut reconnects,
            |_| Err::<(), _>(anyhow!("fixture raw error")),
            |_| panic!("network loss must not renew credentials"),
            |reconnects| *reconnects += 1,
        )
        .unwrap_err();
        assert_eq!(reconnects, 2);
        assert_eq!(read_failure(&error), "NEO_READ:read_unavailable");
    }

    #[test]
    fn only_a_typed_rejection_can_end_the_session_as_auth_required() {
        assert_eq!(read_failure(&anyhow!("Sync service returned -13")), "NEO_READ:read_unavailable");
        let mut attempts = 0;
        let mut renewals = 0;
        let error = recover(
            &mut (),
            |_| {
                attempts += 1;
                Err::<(), _>(ServiceRejected::new(Service::Sync, -13).into())
            },
            |_| {
                renewals += 1;
                Err(ServiceRejected::new(Service::AutomaticAuthentication, -100).into())
            },
            |_| {},
        )
        .unwrap_err();
        assert_eq!((attempts, renewals), (1, 1));
        assert_eq!(read_failure(&error), "NEO_READ:auth_required:-100");

        let rejection = anyhow::Error::new(ServiceRejected::new(Service::Sync, -1))
            .context("fixture raw error");
        assert_eq!(read_failure(&rejection), "NEO_READ:service_rejected:-1");
        assert_eq!(
            read_failure(&anyhow::Error::new(AccountInterrupted::Stopped)),
            "NEO_READ:account_interrupted"
        );
    }

    #[test]
    fn successful_renewal_reconnects_and_allows_one_more_read() {
        let mut operations = vec![];
        recover(
            &mut operations,
            |operations| {
                operations.push("read");
                if operations.len() == 1 {
                    Err(ServiceRejected::new(Service::Heartbeat, -13).into())
                } else {
                    Ok(())
                }
            },
            |operations| { operations.push("renew"); Ok(()) },
            |operations| operations.push("reconnect"),
        )
        .unwrap();
        assert_eq!(operations, ["read", "renew", "reconnect", "read"]);
    }
}
