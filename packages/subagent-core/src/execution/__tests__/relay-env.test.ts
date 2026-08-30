import { describe, expect, it } from 'vitest';

import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
  isRelayActive,
} from '../relay-env.js';

describe('relay env SSOT', () => {
  it('激活判定：三 env 同时非空', () => {
    expect(isRelayActive({ [RELAY_ENV_SOCKET]: '/x.sock', [RELAY_ENV_NODE]: '/node', [RELAY_ENV_SCRIPT]: '/relay.mjs' })).toBe(true);
  });

  it('任一缺失即不激活（全有或全无）', () => {
    const full = {
      [RELAY_ENV_SOCKET]: '/x.sock',
      [RELAY_ENV_NODE]: '/node',
      [RELAY_ENV_SCRIPT]: '/relay.mjs',
    };
    expect(isRelayActive({ ...full, [RELAY_ENV_SOCKET]: '' })).toBe(false);
    expect(isRelayActive({ ...full, [RELAY_ENV_NODE]: undefined })).toBe(false);
    expect(isRelayActive({})).toBe(false);
    expect(isRelayActive(process.env)).toBe(false);
  });

  it('env 名与退出码稳定（relay.mjs 镜像一致性由 conformance relay 断言锁定）', () => {
    expect(RELAY_ENV_SESSION_ID).toBe('XYZ_SUBAGENT_RELAY_SESSION_ID');
    expect(RELAY_ENV_RECORD_ID).toBe('XYZ_SUBAGENT_RELAY_RECORD_ID');
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(RELAY_EXIT_CODES).toEqual({
      VERSION_MISMATCH: 10,
      SOCKET_UNREACHABLE: 11,
      SOCKET_CLOSED: 12,
      MISSING_IDENTITY: 13,
    });
  });
});
