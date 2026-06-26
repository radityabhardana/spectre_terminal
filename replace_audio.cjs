const fs = require('fs');
let appJs = fs.readFileSync('public/app.js', 'utf-8');

// Replace old audio logic
const oldAudioRegex = /let isAudioMuted = false;[\s\S]*?function playQueueDoneSound\(\) \{[\s\S]*?osc\.stop\(audioCtx\.currentTime \+ 0\.3\);\n\}/;

const newAudioLogic = `const SoundManager = {
  ctx: null,
  config: {
    enabled: true,
    soundType: 'chime',
    snifferEnabled: true,
    queueEnabled: true,
    alertsEnabled: true
  },
  
  init() {
    const saved = localStorage.getItem('soundConfig');
    if (saved) this.config = { ...this.config, ...JSON.parse(saved) };
    
    const btnAudio = document.getElementById('toggleAudioBtn');
    if(btnAudio) {
      this.updateBtnState(btnAudio);
      btnAudio.onclick = () => {
        this.config.enabled = !this.config.enabled;
        this.updateBtnState(btnAudio);
        this.save();
        if(this.config.enabled) this.playType(this.config.soundType);
      };
    }

    const selectSoundType = document.getElementById('selectSoundType');
    if(selectSoundType) {
      selectSoundType.value = this.config.soundType;
      selectSoundType.onchange = (e) => {
        this.config.soundType = e.target.value;
        this.save();
        this.playType(this.config.soundType);
      };
    }

    const btnTestSound = document.getElementById('btnTestSound');
    if(btnTestSound) {
      btnTestSound.onclick = () => {
        this.playType(this.config.soundType, true);
      }
    }

    ['Sniffer', 'Queue', 'Alerts'].forEach(key => {
      const chk = document.getElementById('chkSound' + key);
      const confKey = key.toLowerCase() + 'Enabled';
      if(chk) {
        chk.checked = this.config[confKey];
        chk.onchange = (e) => {
          this.config[confKey] = e.target.checked;
          this.save();
        }
      }
    });
  },

  updateBtnState(btn) {
    btn.textContent = this.config.enabled ? "ON" : "OFF";
    btn.style.color = this.config.enabled ? "var(--green)" : "var(--text-tertiary)";
    btn.style.borderColor = this.config.enabled ? "var(--green)" : "var(--text-tertiary)";
    btn.style.background = this.config.enabled ? "rgba(45,184,112,0.1)" : "rgba(255,255,255,0.05)";
  },
  
  save() {
    localStorage.setItem('soundConfig', JSON.stringify(this.config));
  },
  
  play(event) {
    if (!this.config.enabled) return;
    if (event === 'sniffer' && !this.config.snifferEnabled) return;
    if (event === 'queue' && !this.config.queueEnabled) return;
    if (event === 'alerts' && !this.config.alertsEnabled) return;
    
    this.playType(this.config.soundType);
  },

  playType(type, force = false) {
    if (!force && !this.config.enabled) return;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    
    if (type === 'beep') this.playBeep();
    else if (type === 'coin') this.playCoin();
    else this.playChime();
  },
  
  playBeep() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  },
  
  playCoin() {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(987.77, this.ctx.currentTime);
    osc.frequency.setValueAtTime(1318.51, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.4);
  },
  
  playChime() {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(523.25, this.ctx.currentTime);
    osc2.frequency.setValueAtTime(659.25, this.ctx.currentTime);
    gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    osc1.start();
    osc2.start();
    osc1.stop(this.ctx.currentTime + 0.5);
    osc2.stop(this.ctx.currentTime + 0.5);
  }
};

window.playAlertSound = () => SoundManager.play('alerts');
window.playQueueDoneSound = () => SoundManager.play('queue');
window.playSnifferSound = () => SoundManager.play('sniffer');

document.addEventListener('DOMContentLoaded', () => SoundManager.init());`;

appJs = appJs.replace(oldAudioRegex, newAudioLogic);

// Add playSnifferSound to showWhaleToast
const showWhaleRegex = /function showWhaleToast\(whale\) \{/;
appJs = appJs.replace(showWhaleRegex, "function showWhaleToast(whale) {\n  window.playSnifferSound();");

// Remove old toggleAudioBtn listeners at bottom
const oldAudioEvtRegex = /toggleAudioBtn\.addEventListener\("click", \(\) => \{[\s\S]*?\}\);/g;
appJs = appJs.replace(oldAudioEvtRegex, "");

// Remove updateAudioBtnState definition at bottom
const updateAudioStateRegex = /function updateAudioBtnState\(\) \{[\s\S]*?\}\s*(?=\n\s*async function fetchStats\(\))/g;
appJs = appJs.replace(updateAudioStateRegex, "");

// Also let audioEnabled = ... at the top
appJs = appJs.replace(/let audioEnabled = localStorage\.getItem\("audioEnabled"\) !== "false";/, "");

fs.writeFileSync('public/app.js', appJs);
console.log('Audio logic replaced successfully');
