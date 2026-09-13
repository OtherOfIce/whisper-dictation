const wave = document.getElementById('wave');
const bars = Array.from({ length: 13 }, () => { const bar = document.createElement('span'); bar.className = 'bar'; bar.style.height = '3px'; wave.append(bar); return bar; });
const levels = Array(13).fill(0);
function update(state) {
  const busy = state.mode === 'Busy';
  wave.classList.toggle('busy', busy);
  document.querySelector('.pill').classList.toggle('locked', state.mode === 'Locked');
  document.getElementById('finish').disabled = busy;
  levels.shift(); levels.push(Math.min(1, (state.level || 0) * 4));
  if (!busy) bars.forEach((bar, i) => { bar.style.height = `${3 + levels[i] * 20}px`; });
}
window.whisper.onEvent(event => { if (event.type === 'state') update(event); });
window.whisper.call('initial').then(result => update(result.state));
document.getElementById('cancel').onclick = () => window.whisper.call('cancel').catch(() => {});
document.getElementById('finish').onclick = () => window.whisper.call('finish').catch(() => {});
