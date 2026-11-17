/* ======================================================================
   TERMINE – App-Logik
   Zwei Betriebsarten, gleiche Bedienung:
   - Test-Modus: alles nur lokal auf diesem Gerät (config.js leer)
   - Online-Modus: Firebase (kostenloser Spark-Tarif), Daten synchron
   ====================================================================== */
const USERNAME_RE = /^[a-z0-9_.-]{3,20}$/;
const MIN_PW = 6;

/* ---------------------------------------------------------------------
   Backend 1: lokal (Test-Modus)
   --------------------------------------------------------------------- */
function makeLocal(){
  const KEY='termine_db_v2', SKEY='termine_session_v2';
  const load=()=>{try{return JSON.parse(localStorage.getItem(KEY))||{users:{},tasks:[]}}catch(e){return {users:{},tasks:[]}}};
  let db=load(), cb=null, cur=null; const subs=new Set();
  const save=()=>localStorage.setItem(KEY,JSON.stringify(db));
  const notify=()=>subs.forEach(f=>f());
  const prof=n=>{const u=db.users[n];return u?{uid:n,name:n,role:u.role,children:u.children||[]}:null};
  async function hash(s){
    try{const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('termine::'+s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
    catch(e){let h=0;for(const c of 'termine::'+s){h=(h*31+c.charCodeAt(0))|0}return 'x'+h}
  }
  return {
    mode:'local',
    init(f){cb=f;const s=localStorage.getItem(SKEY);cur=(s&&db.users[s])?s:null;f(cur?prof(cur):null)},
    async register(name,pw,role){
      if(db.users[name]) throw new Error('Diesen Benutzernamen gibt es schon.');
      db.users[name]={pw:await hash(pw),role,children:[]};save();
      cur=name;localStorage.setItem(SKEY,name);cb(prof(name));
    },
    async login(name,pw){
      const u=db.users[name];
      if(!u||u.pw!==await hash(pw)) throw new Error('Benutzername oder Passwort stimmt nicht.');
      cur=name;localStorage.setItem(SKEY,name);cb(prof(name));
    },
    async logout(){cur=null;localStorage.removeItem(SKEY);cb(null)},
    watchTasks(uid,f){
      const run=()=>f(db.tasks.filter(t=>t.ownerUid===uid||t.creatorUid===uid).map(t=>({...t})));
      subs.add(run);run();return ()=>subs.delete(run);
    },
    async addTask(t){db.tasks.push(t);save();notify()},
    async setDone(id,done){const t=db.tasks.find(x=>x.id===id);if(t){t.done=done;t.doneAt=done?new Date().toISOString():null;save();notify()}},
    async deleteTask(id){db.tasks=db.tasks.filter(x=>x.id!==id);save();notify()},
    async addChild(name){
      const c=db.users[name];
      if(!c) throw new Error('Diesen Benutzer gibt es nicht.');
      if(c.role!=='kind') throw new Error('Das ist kein Kind-Konto.');
      const me=db.users[cur]; me.children=me.children||[];
      const child={uid:name,name};me.children.push(child);save();return child;
    }
  };
}

/* ---------------------------------------------------------------------
   Backend 2: Firebase (Online-Modus)
   --------------------------------------------------------------------- */
async function makeFirebase(cfg){
  const base='https://www.gstatic.com/firebasejs/10.14.1/';
  const [A,Au,F]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
  const app=A.initializeApp(cfg), auth=Au.getAuth(app), fs=F.getFirestore(app);
  const mail=n=>n+'@termine.local';
  let cb=null, registering=false;

  const fbErr=e=>{
    const c=(e&&e.code)||'';
    if(c==='auth/email-already-in-use') return new Error('Diesen Benutzernamen gibt es schon.');
    if(['auth/invalid-credential','auth/user-not-found','auth/wrong-password','auth/invalid-login-credentials'].includes(c)) return new Error('Benutzername oder Passwort stimmt nicht.');
    if(c==='auth/weak-password') return new Error('Das Passwort braucht mindestens '+MIN_PW+' Zeichen.');
    if(c==='auth/network-request-failed'||c==='unavailable') return new Error('Keine Internetverbindung.');
    if(c==='auth/operation-not-allowed') return new Error('In Firebase ist „E-Mail/Passwort“ noch nicht aktiviert.');
    if(c==='auth/too-many-requests') return new Error('Zu viele Versuche – bitte kurz warten.');
    if(c==='permission-denied') return new Error('Nicht erlaubt – bitte die Firestore-Regeln prüfen.');
    return new Error('Fehler: '+(c||e.message||'unbekannt'));
  };
  async function loadProfile(u){
    const s=await F.getDoc(F.doc(fs,'users',u.uid));
    if(!s.exists()) return null;
    const d=s.data();
    return {uid:u.uid,name:d.username,role:d.role,children:d.children||[]};
  }

  return {
    mode:'online',
    init(f){
      cb=f;
      Au.onAuthStateChanged(auth,async u=>{
        if(registering) return;
        if(!u) return f(null);
        try{
          const p=await loadProfile(u);
          if(!p){await Au.signOut(auth);return f(null)}
          f(p);
        }catch(e){f(null)}
      });
    },
    async register(name,pw,role){
      registering=true;
      try{
        let cred;
        try{cred=await Au.createUserWithEmailAndPassword(auth,mail(name),pw)}catch(e){throw fbErr(e)}
        try{
          const b=F.writeBatch(fs);
          b.set(F.doc(fs,'usernames',name),{uid:cred.user.uid});
          b.set(F.doc(fs,'users',cred.user.uid),{username:name,role,children:[]});
          await b.commit();
        }catch(e){
          try{await cred.user.delete()}catch(_){}
          throw (e&&e.code==='permission-denied')?new Error('Diesen Benutzernamen gibt es schon.'):fbErr(e);
        }
      } finally { registering=false; }
      const p=await loadProfile(auth.currentUser);
      cb(p);
    },
    async login(name,pw){
      try{await Au.signInWithEmailAndPassword(auth,mail(name),pw)}catch(e){throw fbErr(e)}
    },
    async logout(){await Au.signOut(auth)},
    watchTasks(uid,f){
      const col=F.collection(fs,'tasks');
      let a=[],b=[],g1=false,g2=false;
      const push=()=>{
        if(!(g1&&g2)) return;
        const m=new Map();[...a,...b].forEach(t=>m.set(t.id,t));
        f([...m.values()]);
      };
      const u1=F.onSnapshot(F.query(col,F.where('ownerUid','==',uid)),s=>{a=s.docs.map(d=>({...d.data(),id:d.id}));g1=true;push()},e=>{console.warn(e);g1=true;push()});
      const u2=F.onSnapshot(F.query(col,F.where('creatorUid','==',uid)),s=>{b=s.docs.map(d=>({...d.data(),id:d.id}));g2=true;push()},e=>{console.warn(e);g2=true;push()});
      return ()=>{u1();u2()};
    },
    async addTask(t){try{await F.setDoc(F.doc(fs,'tasks',t.id),t)}catch(e){throw fbErr(e)}},
    async setDone(id,done){try{await F.updateDoc(F.doc(fs,'tasks',id),{done,doneAt:done?new Date().toISOString():null})}catch(e){throw fbErr(e)}},
    async deleteTask(id){try{await F.deleteDoc(F.doc(fs,'tasks',id))}catch(e){throw fbErr(e)}},
    async addChild(name){
      try{
        const s=await F.getDoc(F.doc(fs,'usernames',name));
        if(!s.exists()) throw new Error('Diesen Benutzer gibt es nicht.');
        const cuid=s.data().uid;
        const p=await F.getDoc(F.doc(fs,'users',cuid));
        if(!p.exists()||p.data().role!=='kind') throw new Error('Das ist kein Kind-Konto.');
        const child={uid:cuid,name};
        await F.updateDoc(F.doc(fs,'users',auth.currentUser.uid),{children:F.arrayUnion(child)});
        return child;
      }catch(e){ if(e instanceof Error&&!e.code) throw e; throw fbErr(e); }
    }
  };
}

/* ---------------------------------------------------------------------
   Hilfsfunktionen
   --------------------------------------------------------------------- */
let B=null, user=null, tasks=[], unsub=null, lastSig='', gotFirst=false;
let view='own', prevView='own', cat='Alle', selChild=null;
let justDone=null, newId=null;

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid_=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const $=s=>document.querySelector(s);
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),2400)}

(function bubbles(){
  const sky=$('#sky');
  for(let i=0;i<8;i++){
    const b=document.createElement('span');b.className='bub';
    const s=10+Math.random()*26;
    b.style.cssText=`width:${s}px;height:${s}px;left:${Math.random()*100}%;--dx:${(Math.random()*120-60)|0}px;animation-duration:${14+Math.random()*14}s;animation-delay:-${Math.random()*20}s`;
    sky.appendChild(b);
  }
})();

function burst(el){
  const r=el.getBoundingClientRect();
  const w=document.createElement('div');w.className='burst';
  w.style.left=(r.left+r.width/2)+'px';w.style.top=(r.top+r.height/2)+'px';
  const cols=['#ff9a1f','#ff3d00','#ffd54a','#ffffff','#ff6a00'];
  for(let i=0;i<12;i++){
    const s=document.createElement('i'),a=Math.PI*2*i/12+Math.random()*.5,d=34+Math.random()*34;
    s.style.setProperty('--x',(Math.cos(a)*d).toFixed(1)+'px');
    s.style.setProperty('--y',(Math.sin(a)*d).toFixed(1)+'px');
    s.style.background=cols[i%cols.length];w.appendChild(s);
  }
  document.body.appendChild(w);setTimeout(()=>w.remove(),800);
}
function greeting(){const h=new Date().getHours();return h<11?'Guten Morgen':h<17?'Guten Mittag':'Guten Abend'}
function fmtDate(d){if(!d)return '';const p=d.split('-');return `${p[2]}.${p[1]}.`}
function fmtDT(s){if(!s)return '';const d=new Date(s);return d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}
function sheet(html){
  const bg=document.createElement('div');bg.className='sheetbg';
  bg.innerHTML=`<div class="sheet">${html}</div>`;
  bg.addEventListener('click',e=>{if(e.target===bg)bg.remove()});
  document.body.appendChild(bg);return bg;
}

/* ---------------------------------------------------------------------
   Anmeldung
   --------------------------------------------------------------------- */
let authMode='login', authRole='kind';
function renderLoading(){$('#app').innerHTML='<div class="loading">📖 Lade …</div>'}
function renderFatal(msg){
  $('#app').innerHTML=`<div class="auth enter"><div class="card"><h2 style="margin:0 0 8px;color:var(--o2)">Ups</h2><div>${esc(msg)}</div><button class="btn" onclick="location.reload()">Nochmal versuchen</button></div></div>`;
}
function renderAuth(err='',anim=true){
  const online=B&&B.mode==='online';
  $('#app').innerHTML=`
  <div class="auth ${anim?'enter':''}">
    <h1><span class="logo">📖</span> Quests</h1>
    <div class="sub">${authMode==='login'?'Melde dich an':'Neuen Account erstellen'}</div>
    <div class="card">
      ${authMode==='register'?`
        <label>Ich bin …</label>
        <div class="roles">
          <div class="role ${authRole==='kind'?'on':''}" data-r="kind">🧒 Kind</div>
          <div class="role ${authRole==='erwachsen'?'on':''}" data-r="erwachsen">🧑 Erwachsen</div>
        </div>`:''}
      <label>Benutzername</label>
      <input id="u" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">
      <label>Passwort</label>
      <input id="p" type="password" autocomplete="${authMode==='login'?'current-password':'new-password'}">
      ${authMode==='register'?`<label>Passwort wiederholen</label><input id="p2" type="password" autocomplete="new-password">`:''}
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" id="go">${authMode==='login'?'Anmelden':'Account erstellen'}</button>
      <button class="link" id="sw">${authMode==='login'?'Noch keinen Account? Hier erstellen':'Schon einen Account? Anmelden'}</button>
    </div>
    <div class="modehint">${online?'☁️ Online – Daten werden synchronisiert':'📱 Test-Modus – Daten nur auf diesem Gerät'}</div>
  </div>`;
  document.querySelectorAll('.role').forEach(r=>r.onclick=()=>{authRole=r.dataset.r;const u=$('#u').value;renderAuth('',false);$('#u').value=u});
  $('#sw').onclick=()=>{authMode=authMode==='login'?'register':'login';renderAuth()};
  $('#go').onclick=doAuth;
  $('#p').onkeydown=e=>{if(e.key==='Enter')doAuth()};
}
function renderAuthErr(m){const e=$('#err');if(e)e.textContent=m}
async function doAuth(){
  const name=$('#u').value.trim().toLowerCase(), pw=$('#p').value;
  if(!name||!pw) return renderAuthErr('Bitte Benutzername und Passwort eingeben.');
  if(authMode==='register'){
    if(!USERNAME_RE.test(name)) return renderAuthErr('Benutzername: 3–20 Zeichen, nur Buchstaben, Zahlen, _ . -');
    if(pw.length<MIN_PW) return renderAuthErr('Das Passwort braucht mindestens '+MIN_PW+' Zeichen.');
    if(pw!==$('#p2').value) return renderAuthErr('Die Passwörter sind nicht gleich.');
  }
  const btn=$('#go'), label=btn.textContent;
  btn.disabled=true;btn.textContent='…';renderAuthErr('');
  try{
    if(authMode==='register') await B.register(name,pw,authRole); else await B.login(name,pw);
  }catch(e){
    const b=$('#go'); if(b){b.disabled=false;b.textContent=label}
    renderAuthErr(e.message||'Das hat nicht geklappt.');
  }
}

/* ---------------------------------------------------------------------
   Benutzer- und Aufgaben-Status
   --------------------------------------------------------------------- */
function onUser(u){
  if(unsub){unsub();unsub=null}
  user=u;tasks=[];lastSig='';gotFirst=false;
  if(!u){renderAuth();return}
  view='own';prevView='own';cat='Alle';
  selChild=(u.children||[])[0]||null;
  renderLoading();
  unsub=B.watchTasks(u.uid,list=>{
    const sig=JSON.stringify(list.map(t=>[t.id,t.title,t.date,t.time,t.category,t.expires,t.done,t.doneAt]).sort());
    if(gotFirst&&sig===lastSig) return;
    lastSig=sig;tasks=list;cleanup();
    const first=!gotFirst;gotFirst=true;
    renderMain(first);
  });
}
const isAdult=()=>user.role==='erwachsen';

/* abgelaufene Einträge: ausblenden, und selbst erstellte endgültig löschen */
function cleanup(){
  const now=Date.now();
  tasks.forEach(t=>{
    if(t.expires&&new Date(t.expires).getTime()<=now&&t.creatorUid===user.uid) B.deleteTask(t.id).catch(()=>{});
  });
}
function visibleTasks(){
  const now=Date.now();
  const alive=tasks.filter(t=>!t.expires||new Date(t.expires).getTime()>now);
  if(view==='own') return alive.filter(t=>t.ownerUid===user.uid&&t.creatorUid===user.uid);
  if(isAdult()) return selChild?alive.filter(t=>t.creatorUid===user.uid&&t.ownerUid===selChild.uid):[];
  return alive.filter(t=>t.ownerUid===user.uid&&t.creatorUid!==user.uid);
}
const sortKey=t=>(t.date||'9999-12-31')+' '+(t.time||'23:59');
const CHECK='<svg viewBox="0 0 24 24"><path pathLength="1" d="M5 12.5l4.5 4.5L19 7"/></svg>';

/* ---------------------------------------------------------------------
   Hauptansicht
   --------------------------------------------------------------------- */
function renderMain(anim=false){
  if(!user) return;
  const adult=isAdult();
  const all=visibleTasks();
  const cats=[...new Set(all.map(t=>t.category).filter(Boolean))];
  if(cat!=='Alle'&&!cats.includes(cat)) cat='Alle';
  const list=all.filter(t=>cat==='Alle'||t.category===cat).sort((a,b)=>sortKey(a).localeCompare(sortKey(b)));
  const done=all.filter(t=>t.done).length;
  const otherLabel=adult?'Kind':'Eltern';
  const canAdd=view==='own'||adult;
  const readOnly=view==='other'&&adult;
  const h=new Date().getHours(), emoji=h<11?'☀️':h<17?'🌤️':'🌙';

  $('#app').innerHTML=`
    <div class="top">
      <div><h1>${greeting()}, ${esc(user.name)}! <span class="wave">👋</span></h1><div class="sub">${emoji} ${adult?'Erwachsenen-Konto':'Kind-Konto'}${B.mode==='online'?' · ☁️':''}</div></div>
      <button class="logout" id="lo">Abmelden</button>
    </div>
    <div class="seg" id="seg" data-pos="${prevView}">
      <button class="${view==='own'?'on':''}" data-v="own">Eigene</button>
      <button class="${view==='other'?'on':''}" data-v="other">${otherLabel}</button>
    </div>
    ${view==='other'&&adult?`
      <div class="bar">
        <button class="plus" id="addchild" title="Kind hinzufügen" style="font-size:22px">👶</button>
        ${(user.children||[]).map(c=>`<button class="chip ${selChild&&c.uid===selChild.uid?'on':''}" data-c="${esc(c.uid)}">${esc(c.name)}</button>`).join('')}
      </div>`:''}
    ${view==='other'&&adult&&!selChild?`
      <div class="empty"><div class="big">👶</div><br>Füge zuerst ein Kind per Benutzername hinzu (👶 oben).</div>`:`
    <div class="bar">
      ${canAdd?`<button class="plus ${all.length?'':'pulse'}" id="add">+</button>`:''}
      <button class="chip ${cat==='Alle'?'on':''}" data-k="Alle">Alle</button>
      ${cats.map(c=>`<button class="chip ${cat===c?'on':''}" data-k="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    ${all.length?`<div class="progress">${done} von ${all.length} erledigt ${done===all.length?'🎉':''}<div class="pbar"><div class="pfill" style="--p:${(done/all.length).toFixed(3)}"></div></div></div>`:''}
    ${list.length?list.map((t,i)=>taskHTML(t,readOnly,anim,i)).join(''):`
      <div class="empty"><div class="big">${view==='other'?'📭':'✨'}</div><br>${
        view==='other'?(adult?'Für dein Kind gibt es noch nichts.':'Deine Eltern haben dir nichts eingetragen.'):'Noch keine Quests – tippe auf +'}</div>`}
    `}`;

  const seg=$('#seg');
  if(prevView!==view){requestAnimationFrame(()=>requestAnimationFrame(()=>{seg.dataset.pos=view}))}
  prevView=view;

  $('#lo').onclick=()=>B.logout();
  document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{if(view===b.dataset.v)return;view=b.dataset.v;cat='Alle';renderMain(true)});
  document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{cat=b.dataset.k;renderMain(true)});
  document.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>{selChild=user.children.find(c=>c.uid===b.dataset.c)||null;cat='Alle';renderMain(true)});
  const a=$('#add');if(a)a.onclick=openCreate;
  const ac=$('#addchild');if(ac)ac.onclick=openAddChild;
  document.querySelectorAll('.check:not(.ro)').forEach(b=>b.onclick=()=>toggle(b.dataset.id));
  document.querySelectorAll('.del').forEach(b=>b.onclick=()=>askDelete(b.dataset.id));

  if(justDone){const el=document.querySelector(`.check[data-id="${justDone}"]`);if(el)burst(el);justDone=null}
  newId=null;
}

function taskHTML(t,readOnly,anim,i){
  const canDelete=t.creatorUid===user.uid;
  const tags=[
    t.category?`<span class="tag">${esc(t.category)}</span>`:'',
    (t.time||t.date)?`⏰ ${esc(fmtDate(t.date))} ${esc(t.time||'')}`:'',
  ].join('');
  const extra=[];
  if(t.expires) extra.push('🗑️ weg am '+fmtDT(t.expires));
  if(view==='other'&&!isAdult()) extra.push('von '+esc(t.creatorName||'?'));
  if(readOnly) extra.push(t.done?'✅ erledigt'+(t.doneAt?' ('+fmtDT(t.doneAt)+')':''):'⏳ noch offen');
  const enter=(anim||t.id===newId)?'enter':'';
  return `
  <div class="task ${t.done?'done':''} ${enter}" style="--i:${Math.min(i,10)}">
    <button class="check ${t.done?'on':''} ${t.id===justDone?'just':''} ${readOnly?'ro':''}" data-id="${esc(t.id)}" ${readOnly?'disabled':''} aria-label="Erledigt">${CHECK}</button>
    <div class="tbody">
      <div class="ttitle">${esc(t.title)}</div>
      <div class="meta">${tags}</div>
      ${extra.length?`<div class="meta">${extra.join(' · ')}</div>`:''}
    </div>
    ${canDelete?`<button class="del" data-id="${esc(t.id)}" aria-label="Löschen">🗑</button>`:''}
  </div>`;
}

async function toggle(id){
  const t=tasks.find(x=>x.id===id);if(!t)return;
  const nowDone=!t.done;
  if(nowDone){justDone=id;try{navigator.vibrate&&navigator.vibrate(15)}catch(e){}}
  try{await B.setDone(id,nowDone)}catch(e){justDone=null;toast(e.message||'Hat nicht geklappt')}
}

/* eigener Dialog statt confirm() – der wird in App/Vorschau oft blockiert */
function askDelete(id){
  const bg=sheet(`
    <h2>Löschen?</h2>
    <div class="hint" style="font-size:14px;margin-top:6px">Dieser Eintrag wird entfernt.</div>
    <button class="btn" id="yes" style="background:linear-gradient(135deg,#ff5a3d,#c62800)">Ja, löschen</button>
    <button class="btn ghost" id="no">Abbrechen</button>`);
  bg.querySelector('#no').onclick=()=>bg.remove();
  bg.querySelector('#yes').onclick=()=>{bg.remove();doDelete(id)};
}
function doDelete(id){
  const btn=document.querySelector(`.del[data-id="${id}"]`);
  const card=btn&&btn.closest('.task');
  const run=async()=>{try{await B.deleteTask(id);toast('Gelöscht')}catch(e){toast(e.message||'Löschen hat nicht geklappt');renderMain(false)}};
  if(card){card.classList.remove('enter');card.classList.add('out');setTimeout(run,280)}else run();
}

/* ---------------------------------------------------------------------
   Termin erstellen / Kind hinzufügen
   --------------------------------------------------------------------- */
function openCreate(){
  const forChild=view==='other'&&isAdult();
  if(forChild&&!selChild) return toast('Erst ein Kind hinzufügen');
  const known=[...new Set(tasks.map(t=>t.category).filter(Boolean))];
  const today=new Date().toISOString().slice(0,10);
  const bg=sheet(`
    <h2>Neue Quest${forChild?' für '+esc(selChild.name):''}</h2>
    <label>Name</label><input id="n" placeholder="z. B. Zimmer aufräumen" maxlength="80">
    <div class="row2">
      <div><label>Datum</label><input id="d" type="date" value="${today}"></div>
      <div><label>Uhrzeit</label><input id="t" type="time"></div>
    </div>
    <label>Kategorie</label>
    <input id="k" list="kl" placeholder="z. B. Schule, Haushalt …" maxlength="24">
    <datalist id="kl">${known.map(k=>`<option value="${esc(k)}">`).join('')}</datalist>
    <label>Verschwindet automatisch am (optional)</label>
    <input id="x" type="datetime-local">
    <div class="hint">Leer lassen = bleibt, bis du es löschst.</div>
    <button class="btn" id="save">Speichern</button>
    <button class="btn ghost" id="cancel">Abbrechen</button>`);
  bg.querySelector('#cancel').onclick=()=>bg.remove();
  bg.querySelector('#save').onclick=async()=>{
    const title=bg.querySelector('#n').value.trim();
    if(!title) return toast('Bitte einen Namen eingeben');
    const expires=bg.querySelector('#x').value;
    if(expires&&new Date(expires).getTime()<=Date.now()) return toast('Das Ablaufdatum liegt in der Vergangenheit');
    const id=uid_();
    const t={
      id,title,
      date:bg.querySelector('#d').value,time:bg.querySelector('#t').value,
      category:bg.querySelector('#k').value.trim(),
      expires,done:false,doneAt:null,
      ownerUid:forChild?selChild.uid:user.uid,ownerName:forChild?selChild.name:user.name,
      creatorUid:user.uid,creatorName:user.name,created:new Date().toISOString()
    };
    newId=id;
    try{await B.addTask(t);bg.remove();toast('Gespeichert ✓')}
    catch(e){newId=null;toast(e.message||'Speichern hat nicht geklappt')}
  };
  setTimeout(()=>bg.querySelector('#n').focus(),100);
}
function openAddChild(){
  const bg=sheet(`
    <h2>Kind hinzufügen</h2>
    <div class="hint">Dein Kind braucht zuerst einen eigenen Account (Typ „Kind“).</div>
    <label>Benutzername des Kindes</label><input id="cn" autocapitalize="none" autocorrect="off" spellcheck="false">
    <div class="err" id="ce"></div>
    <button class="btn" id="ok">Hinzufügen</button>
    <button class="btn ghost" id="no">Abbrechen</button>`);
  bg.querySelector('#no').onclick=()=>bg.remove();
  bg.querySelector('#ok').onclick=async()=>{
    const n=bg.querySelector('#cn').value.trim().toLowerCase();
    const err=m=>bg.querySelector('#ce').textContent=m;
    if(!n) return err('Bitte einen Benutzernamen eingeben.');
    if((user.children||[]).some(c=>c.name===n)) return err('Schon hinzugefügt.');
    try{
      const child=await B.addChild(n);
      user.children=[...(user.children||[]),child];selChild=child;
      bg.remove();renderMain(true);toast('Kind hinzugefügt ✓');
    }catch(e){err(e.message||'Hat nicht geklappt.')}
  };
}

/* ---------------------------------------------------------------------
   Start
   --------------------------------------------------------------------- */
(async function init(){
  renderLoading();
  const cfg=window.FIREBASE_CONFIG;
  try{
    B=(cfg&&cfg.apiKey)?await makeFirebase(cfg):makeLocal();
  }catch(e){
    console.warn(e);
    return renderFatal('Die Online-Verbindung konnte nicht geladen werden. Bitte Internet prüfen.');
  }
  B.init(onUser);
  setInterval(()=>{if(user&&gotFirst&&!document.hidden&&!document.querySelector('.sheetbg')){cleanup();renderMain(false)}},30000);
  if('serviceWorker' in navigator&&location.protocol.startsWith('http')&&location.hostname!=='localhost'){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
