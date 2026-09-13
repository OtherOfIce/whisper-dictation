const { spawn } = require('node:child_process');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], { cwd: __dirname, env: environment, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
