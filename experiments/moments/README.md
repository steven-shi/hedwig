# 朋友圈独立实验

Rust 实验通过专用微信测试号扫码登录。`--read-latest` 刷新朋友圈首页，最多保留最近 10 条。`--like-if-needed` 验证并尝试给指定动态点赞。`--submit-private` 提交一条带时间戳的纯文字动态。同号登录曾使运行中的 Hedwig 掉线。

## 编译与离线测试

在仓库根目录执行以下命令。构建需要 Rust 1.93.1 或更新版本，以及 OpenSSL 开发依赖。测试使用合成数据校验首页请求、帖子筛选、XML、Protobuf 和发布回执。最后一条命令只显示用法。

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
cp "$experiment_dir/moments_timeline.rs" src/moments_timeline.rs
cp "$experiment_dir/moments_trial.rs" examples/moments_trial.rs
cargo test --locked --lib moments
cargo test --locked --example moments_trial
cargo build --locked --example moments_trial
target/debug/examples/moments_trial --help
```

## 读取最近 10 条

```sh
run_dir=$(mktemp -d)
target/debug/examples/moments_trial --read-latest "$run_dir/login.png" "$run_dir/result"
```

测试号扫码后，结果写入 `result/timeline.json`。其中 `posts` 按发布时间从新到旧排列。每条记录有十进制字符串形式的 `id`、作者账号 `author_id`、可选昵称 `nickname`、Unix 秒 `created_at`、正文 `text` 和图片 `images`。作者账号优先取响应外层字段，缺失时取 XML 的 `username`。正文为 `null` 时表示未能解析 XML，空字符串可表示纯图动态。

图片包含媒体 ID 和可直接访问的来源。程序尝试保存原图，失败时尝试缩略图。`saved_images` 记录成功保存的相对路径和版本，图片下载总时限为 30 秒。受保护的媒体使用 `protected_media` 标记。目录权限为 0700，结果文件权限为 0600。终端仅显示帖子数和图片保存数。

读取使用 `SnsTimeLine` 的 CGI 211。首页请求不带旧游标或缓存摘要，响应外层解析 `SnsObject`，正文和图片从 `ObjectDesc` 的 `TimelineObject` XML 提取。Pi 实测返回 3 条，每条的作者、昵称、时间和正文均可读。5 个图片引用均需要受保护媒体的访问流程，本轮成功下载 0 张。离线测试验证了可直连图片的缩略图回退。[首页请求实现](https://github.com/betteray/WeChat/blob/android/WeChat/Services/SnsTimeLineService.m) · [macOS 4.2 响应及媒体字段](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/bridge/sns_proto.go)

## 给指定动态点赞

```sh
run_dir=$(mktemp -d)
target/debug/examples/moments_trial --like-if-needed POST_ID "$run_dir/login.png"
```

将 `POST_ID` 换成刚刷新得到的十进制 ID。程序先刷新首页并按 ID 查找，已赞返回 `AlreadyLiked`，状态未知返回 `UnknownLikeState`。状态明确为未赞时才提交一次 `SnsComment` 点赞动作。随后只读复查一次。`Confirmed` 表示读回已赞，`AcceptedUnverified` 表示收到成功回执但未读回已赞，`OutcomeUnknown` 需要先从客户端查看实际状态。[macOS 4.2 点赞实现](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/bridge/sns_http.go)

Pi ARM64 上用专用测试号对一条指定动态实测返回 `Confirmed`。已赞和状态未知时跳过的逻辑经过合成数据验证。

## 纯文字发布

使用 `--submit-private` 和一个尚不存在的二维码 PNG 路径。一次 Pi ARM64 实测收到了非零帖子 ID，测试人员在手机上看到了帖子。请求设置为仅自己可见，微信服务端实际可见范围仍需单独确认。常规退出时程序会移除二维码。收到 `POST_OUTCOME_UNKNOWN` 时先在手机确认是否发布。

上游由 Nick Yu 和贡献者构建。补丁基于 [wechat-protocol 2.2.0](https://crates.io/crates/wechat-protocol/2.2.0)。上游许可见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。
