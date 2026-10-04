#!/usr/bin/env node
/**
 * 建/改后台账号、建节点。
 *
 * 用途：在没有 Web 界面（或界面还没构建）时把平台跑起来。
 * 也是部署脚本的一部分 —— 首次初始化不该依赖浏览器。
 *
 * 用法：
 *   node apps/server/src/cli/seed.ts admin <用户名> [口令] [角色]
 *   node apps/server/src/cli/seed.ts node <节点ID> [名称]
 *   node apps/server/src/cli/seed.ts list
 */

import { randomBytes } from 'node:crypto';

import { config } from '../config.ts';
import { Store } from '../store/index.ts';
import { hashSecret, newNodeSecret } from '../lib/crypto.ts';
import type { Role } from '@kokuu/protocol';

const ROLES: Role[] = ['owner', 'admin', 'moderator', 'viewer'];

function usage(): never {
  console.log(
    [
      '用法：',
      '  node apps/server/src/cli/seed.ts user <用户名> [口令] [角色]',
      '  node apps/server/src/cli/seed.ts node <节点ID> [名称]',
      '  node apps/server/src/cli/seed.ts list',
      '',
      `角色可选：${ROLES.join(' / ')}（默认 owner）`,
      '口令省略时会随机生成并打印。',
    ].join('\n'),
  );
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const store = new Store(config.dbFile);

try {
  switch (command) {
    case 'user': {
      const username = rest[0];
      if (!username) usage();

      const password = rest[1] || randomBytes(9).toString('base64url');
      const role = (rest[2] ?? 'owner') as Role;
      if (!ROLES.includes(role)) {
        console.error(`未知角色：${role}，可选 ${ROLES.join(' / ')}`);
        process.exit(1);
      }

      const existing = store.findAccountByUsername(username);
      if (existing) {
        store.updateAccount(existing.id, {
          role,
          passwordHash: hashSecret(password),
          disabled: false,
        });
        store.deleteAccountSessions(existing.id);
        console.log(`已更新账号 ${username}（角色 ${role}），旧会话已全部失效`);
      } else {
        store.createAccount({
          username,
          passwordHash: hashSecret(password),
          role,
        });
        console.log(`已创建账号 ${username}（角色 ${role}）`);
      }

      if (!rest[1]) console.log(`口令：${password}   ← 只显示这一次`);
      break;
    }

    case 'node': {
      const id = rest[0];
      if (!id) usage();

      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
        console.error('节点 ID 只能用 2–64 位小写字母、数字、下划线或连字符，且以字母数字开头');
        process.exit(1);
      }

      const secret = newNodeSecret();
      const name = rest[1] ?? id;

      if (store.getNode(id)) {
        store.updateNodeSecret(id, hashSecret(secret));
        console.log(`节点 ${id} 已存在，密钥已轮换`);
      } else {
        store.createNode({ id, name, secretHash: hashSecret(secret), tags: [] });
        console.log(`已创建节点 ${id}（${name}）`);
      }

      console.log('');
      console.log('把下面三行填进服务端的 plugins/KokuuAgent/config.yml：');
      console.log(`  panel-url: ws://127.0.0.1:${config.port}/agent`);
      console.log(`  node-id:   ${id}`);
      console.log(`  secret:    ${secret}`);
      console.log('');
      console.log('⚠️ 该密钥只显示这一次，关闭后无法再查看，只能轮换。');
      break;
    }

    case 'list': {
      console.log('账号：');
      for (const account of store.listAccounts()) {
        console.log(
          `  #${account.id} ${account.username.padEnd(20)} ${account.role.padEnd(10)}` +
            `${account.disabled ? ' [已停用]' : ''}`,
        );
      }
      console.log('\n节点：');
      const nodes = store.listNodes();
      if (nodes.length === 0) console.log('  （无）');
      for (const node of nodes) {
        console.log(
          `  ${node.id.padEnd(20)} ${node.name.padEnd(16)}` +
            `${node.enabled ? '' : ' [已停用]'} ` +
            `${node.mc_version ?? '从未连接'}`,
        );
      }
      break;
    }

    default:
      usage();
  }
} finally {
  store.close();
}
