import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-uninstall-'));
const repo=process.cwd(), quote=s=>`'${s.replaceAll("'", "'\\''")}'`;
const extract=(file,name)=>fs.readFileSync(file,'utf8').match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))[0];
try {
 const backup=path.join(dir,'backup'),bash=path.join(dir,'bashrc'),zsh=path.join(dir,'zshrc'),fish=path.join(dir,'config.fish');
 const originals=["alias codex='bash-old'\n","alias codex='zsh-old'\n","alias codex 'fish-old'\n"];
 [bash,zsh,fish].forEach((f,i)=>fs.writeFileSync(f,originals[i]));
 const common=`set -eu\nsource ${quote(path.join(repo,'scripts/shell-rc.sh'))}\nBACKUP_FILE=${quote(backup)}\nMARKER='# codex-hud alias'\nwarn(){ :; }\ninfo(){ :; }\nstep(){ :; }\n`;
 const result=spawnSync('bash',['-c',common+extract('install.sh','backup_existing_aliases')+'\n'+[bash,zsh,fish].map(f=>`backup_existing_aliases ${quote(f)}`).join('\n')+'\nrestore_rc_aliases'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 [bash,zsh,fish].forEach((f,i)=>assert.equal(fs.readFileSync(f,'utf8').trim(),originals[i].trim()));
 assert.equal(fs.existsSync(backup+'.d'),false);
 const conflict=spawnSync('bash',['-c',common+`backup_rc_aliases ${quote(zsh)} ${quote("alias codex='older'\n")}\nrestore_rc_aliases`],{encoding:'utf8'});
 assert.equal(conflict.status,0,conflict.stderr);
 assert.equal(fs.readFileSync(zsh,'utf8').trim(),originals[1].trim());
 assert.equal(fs.existsSync(backup+'.d'),true,'keep backup when newer override exists');
 const fake=path.join(dir,'tmux'),log=path.join(dir,'actions');
 fs.writeFileSync(fake,`#!/usr/bin/env bash
case "$1" in
 list-sessions) printf '%s\\n' unrelated own foreign stale legacy crossed ;;
 show-option) case "$3:$5" in
  own:@codex_hud_pane) echo %2;; own:@codex_hud_main_pane) echo %1;; own:@codex_hud_root) echo "$TEST_REPO";;
  foreign:@codex_hud_pane) echo %4;; foreign:@codex_hud_main_pane) echo %3;; foreign:@codex_hud_root) echo /another/checkout;;
  stale:@codex_hud_pane) echo %6;; stale:@codex_hud_main_pane) echo %5;; stale:@codex_hud_root) echo "$TEST_REPO";;
  legacy:@codex_hud_pane) echo %8;; legacy:@codex_hud_main_pane) echo %7;;
  crossed:@codex_hud_pane) echo %10;; crossed:@codex_hud_main_pane) echo %9;; crossed:@codex_hud_root) echo "$TEST_REPO";;
 esac;;
 display-message)
  if [[ "$5" == '#{session_name}' ]]; then
   case "$4" in %1|%2) echo own;; %3|%4) echo foreign;; %5|%6) echo stale;; %7|%8) echo legacy;; %9) echo crossed;; %10) echo unrelated;; esac
  else
   case "$4" in
    %2) echo "bash '$TEST_REPO/bin/codex-hud-renderer'";;
    %8|%10) echo "node '$TEST_REPO/dist/index.js'";;
    *) echo 'node /srv/unrelated-dashboard/dist/index.js';;
   esac
  fi;;
 kill-pane|kill-session) printf '%s\\n' "$*" >> "$TEST_ACTIONS";;
esac
`);fs.chmodSync(fake,0o755);
 const killed=spawnSync('bash',['-c',`SCRIPT_DIR=${quote(repo)}\ninfo(){ :; }\n${extract('uninstall.sh','kill_sessions')}\nkill_sessions`],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,TEST_REPO:repo,TEST_ACTIONS:log},encoding:'utf8'});
 assert.equal(killed.status,0,killed.stderr);
 assert.equal(fs.readFileSync(log,'utf8').trim(),'kill-pane -t %2\nkill-pane -t %8');
 console.log('test-uninstall-ownership-and-backup: PASS');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
