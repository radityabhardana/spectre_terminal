const fs = require('fs');
let appJs = fs.readFileSync('public/app.js', 'utf-8');

const oldSoundManagerRegex = /const SoundManager = \{[\s\S]*?\}\s*};\s*window\.playAlertSound = \(\) => SoundManager\.play\('alerts'\);\nwindow\.playQueueDoneSound = \(\) => SoundManager\.play\('queue'\);\nwindow\.playSnifferSound = \(\) => SoundManager\.play\('sniffer'\);\n\ndocument\.addEventListener\('DOMContentLoaded', \(\) => SoundManager\.init\(\)\);/;

const newSoundManager = `const SoundManager = {
  ctx: null,
  config: {
    enabled: true,
    soundTypeSniffer: 'coin',
    soundTypeQueue: 'chime',
    soundTypeAlerts: 'beep',
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
        if(this.config.enabled) this.playType('chime');
      };
    }

    ['Sniffer', 'Queue', 'Alerts'].forEach(key => {
      // Checkbox for Enable/Disable
      const chk = document.getElementById('chkSound' + key);
      const confKey = key.toLowerCase() + 'Enabled';
      if(chk) {
        chk.checked = this.config[confKey];
        chk.onchange = (e) => {
          this.config[confKey] = e.target.checked;
          this.save();
        }
      }

      // Dropdown for Sound Type
      const sel = document.getElementById('selectSound' + key);
      const typeKey = 'soundType' + key;
      if(sel) {
        sel.value = this.config[typeKey];
        sel.onchange = (e) => {
          this.config[typeKey] = e.target.value;
          this.save();
          this.playType(this.config[typeKey]);
        }
      }
    });

    // Test Buttons
    document.querySelectorAll('.btnTestSound').forEach(btn => {
      btn.onclick = () => {
        const type = btn.dataset.type; // sniffer, queue, alerts
        let soundType = this.config.soundTypeSniffer;
        if (type === 'queue') soundType = this.config.soundTypeQueue;
        else if (type === 'alerts') soundType = this.config.soundTypeAlerts;
        this.playType(soundType, true);
      };
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
    
    let type = 'chime';
    if (event === 'sniffer') type = this.config.soundTypeSniffer;
    else if (event === 'queue') type = this.config.soundTypeQueue;
    else if (event === 'alerts') type = this.config.soundTypeAlerts;

    this.playType(type);
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

if (appJs.match(oldSoundManagerRegex)) {
  appJs = appJs.replace(oldSoundManagerRegex, newSoundManager);
  fs.writeFileSync('public/app.js', appJs);
  console.log('Successfully updated SoundManager to support multiple sound types');
} else {
  console.log('Regex did not match SoundManager block in app.js');
}
