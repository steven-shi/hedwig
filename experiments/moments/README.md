# 朋友圈纯文字发布实验

这是独立的 Rust 实验。它通过微信测试号扫码登录，提交一条带时间戳的纯文字动态。请求设置为仅自己可见，微信服务端实际可见范围仍需单独确认。一次 Pi ARM64 实测收到了非零帖子 ID，测试人员在手机上看到了帖子。同号登录曾使运行中的 Hedwig 掉线。

在仓库根目录执行以下命令。构建需要 Rust 1.93.1 或更新版本，以及 OpenSSL 开发依赖。两项单元测试只验证合成数据的 XML、Protobuf 和回执分类。最后一条命令只显示用法。

```sh
experiment_dir="$PWD/experiments/moments"
trial_dir=$(mktemp -d)
curl -fLsS https://static.crates.io/crates/wechat-protocol/wechat-protocol-2.2.0.crate \
  -o "$trial_dir/wechat-protocol-2.2.0.crate"
printf '%s  %s\n' 31dd60cd137a312e5b531d8ea9ea4115939e64284a97d261c33a2be572308ff7 \
  "$trial_dir/wechat-protocol-2.2.0.crate" | shasum -a 256 -c -
tar -xzf "$trial_dir/wechat-protocol-2.2.0.crate" -C "$trial_dir"
cd "$trial_dir/wechat-protocol-2.2.0"
git apply "$experiment_dir/wechat-protocol-2.2.0.patch"
cp "$experiment_dir/moments_trial.rs" examples/moments_trial.rs
cargo test --locked --lib moments_trial_tests
cargo build --locked --example moments_trial
target/debug/examples/moments_trial --help
```

实际发布时，仅用专用测试号。将 `--help` 换成 `--submit-private` 和一个尚不存在的二维码 PNG 路径。常规退出时程序会移除二维码。收到 `POST_OUTCOME_UNKNOWN` 时先在手机确认是否发布。

上游由 Nick Yu 和贡献者构建。补丁基于 [wechat-protocol 2.2.0](https://crates.io/crates/wechat-protocol/2.2.0)。上游许可见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。
