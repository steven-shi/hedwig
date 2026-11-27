use anyhow::{anyhow, bail, ensure, Result};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    thread,
    time::{Duration, Instant},
};
use wechat_protocol::{
    is_retryable_login_poll_error, wire, DeviceProfile, LoginStatus, MomentsTrialReceipt,
    NativeClient, NativeOptions,
};

fn login(qr_path: &Path) -> Result<NativeClient> {
    let open = || anyhow!("Could not start the isolated login");
    let client = NativeClient::new(NativeOptions::default()).map_err(|_| open())?;
    let device = DeviceProfile::generate("UnifiedPCLinux aarch64".into()).map_err(|_| open())?;
    let mut attempt = client
        .start_qr_login(device, "Hedwig Moments Trial")
        .map_err(|_| open())?;
    let mut image = OpenOptions::new().write(true).create_new(true).mode(0o600).open(qr_path)?;
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
                break client.complete_login(&mut attempt)
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

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] {
        println!("moments_trial --submit-private PATH_TO_NEW_QR_PNG");
        return Ok(());
    }
    ensure!(args.len() == 2 && args[0] == "--submit-private", "Expected --submit-private and QR image path");
    let qr_path = args[1].clone();
    let client = tokio::task::spawn_blocking(move || login(Path::new(&qr_path))).await??;
    println!("LOGIN_READY");
    let created_at = wire::unix_time()?;
    let mut nonce = [0_u8; 16];
    openssl::rand::rand_bytes(&mut nonce)?;
    let text = format!("Hedwig 纯文字朋友圈测试 {created_at}");
    let result = client.submit_moments_trial(text, created_at, hex::encode(nonce)).await;
    let _ = client.shutdown().await;
    match result {
        Ok(MomentsTrialReceipt::Accepted(id)) => println!("POST_ACCEPTED {id}"),
        Ok(MomentsTrialReceipt::Rejected(code)) => bail!("POST_REJECTED {code}"),
        Err(_) => bail!("POST_OUTCOME_UNKNOWN; check the test account before any further action"),
    }
    Ok(())
}
