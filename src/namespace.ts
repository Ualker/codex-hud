// The launcher uses the same canonical namespace implementation as collectors.
import { getCodexDataNamespace } from './utils/codex-path.js';

const [home = '', sessions = '', userHome = process.env.HOME, cwd] = process.argv.slice(2);
if (cwd) process.chdir(cwd);
process.stdout.write(getCodexDataNamespace({ CODEX_HOME: home, CODEX_SESSIONS_PATH: sessions, HOME: userHome }));
