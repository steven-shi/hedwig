import { State } from './state.mjs';

const state = new State(process.env.BRIDGE_STATE_DIR ?? '/state');
switch (process.argv[2]) {
  case 'identify':
    console.log('从要设为管理员的微信账号私聊机器人发送以下命令，核验码 10 分钟有效。');
    console.log('!identify ' + state.beginIdentityCheck());
    break;
  case 'id': {
    const id = state.identifiedSender();
    if (id) console.log(id);
    else { console.error('尚未收到有效核验消息，请重新执行 identify。'); process.exitCode = 1; }
    break;
  }
  default: console.error('用法：node bridge/admin.mjs identify | id'); process.exitCode = 1;
}
