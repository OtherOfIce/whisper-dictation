const wave = document.getElementById('wave');
const pill = document.getElementById('pill');
const cancel = document.getElementById('cancel');
const finish = document.getElementById('finish');
const envelope = [.36, .58, .76, .9, 1, .92, .78, .62, .46, .34];
const heights = envelope.map(level => 3 + level * 10);
const bars = envelope.map(() => { const bar = document.createElement('span'); bar.className = 'bar'; wave.append(bar); return bar; });
let busy = false;
let targetLevel = .6;
let displayLevel = targetLevel;
function update(state) {
  busy = state.mode === 'Busy';
  const lockMode = state.mode === 'LockMode';
  pill.classList.toggle('busy', busy);
  pill.classList.toggle('lock-mode', lockMode);
  pill.setAttribute('aria-label', busy ? 'Transcribing' : 'Recording');
  cancel.hidden = !lockMode;
  finish.hidden = !lockMode;
  if (!busy) targetLevel = Math.max(.2, Math.min(1, (state.level || 0) * 4));
}
function draw(time) {
  displayLevel += (targetLevel - displayLevel) * .12;
  bars.forEach((bar, index) => {
    const target = busy
      ? 4 + envelope[index] * (6 + (Math.sin(time / 210) + 1) * 3)
      : 3 + envelope[index] * displayLevel * 17;
    heights[index] += (target - heights[index]) * .18;
    bar.style.height = `${heights[index].toFixed(2)}px`;
  });
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
window.whisper.onEvent(event => { if (event.type === 'state') update(event); });
window.whisper.call('initial').then(result => update(result.state));
cancel.onclick = () => window.whisper.call('cancel').catch(() => {});
finish.onclick = () => window.whisper.call('finish').catch(() => {});
