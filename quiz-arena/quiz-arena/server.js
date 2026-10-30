const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { QUESTIONS } = require('./questions');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();
const clients = new Map();
const MAX_PLAYERS = 8;
const QUESTION_COUNT = 15;
const QUESTION_MS = Number(process.env.QUESTION_MS || 15_000);
const REVEAL_MS = Number(process.env.REVEAL_MS || 3_000);
const ROOM_TTL = 2 * 60 * 60 * 1000;

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const randomId = (bytes=18) => crypto.randomBytes(bytes).toString('base64url');
const randomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i=0;i<6;i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
};
const safeName = (s) => String(s || '').trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,20);
const shuffle = (arr) => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; };

function publicRoom(room, viewerId) {
  const players = [...room.players.values()].map(p => ({id:p.id,name:p.name,avatar:p.avatar,score:p.score,connected:p.connected,answered:room.phase==='question' ? p.answer!==null : false,isHost:p.id===room.hostId}));
  const sorted = [...players].sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
  const me = room.players.get(viewerId);
  const result = {
    code:room.code, phase:room.phase, players, leaderboard:sorted,
    hostId:room.hostId, isHost:viewerId===room.hostId,
    questionIndex:room.questionIndex, totalQuestions:QUESTION_COUNT,
    deadline:room.deadline, serverNow:Date.now(),
    myAnswer:me?.answer ?? null, myScore:me?.score ?? 0,
    lastResult:room.lastResult, winner:room.winner,
    tieBreakRound:room.tieBreakRound || 0, tieBreak:!!room.tieBreak
  };
  if (room.phase==='question' && room.currentQuestion) {
    result.question = {category:room.currentQuestion.category,question:room.currentQuestion.question,options:room.currentQuestion.options};
  } else if ((room.phase==='reveal' || room.phase==='finished') && room.currentQuestion) {
    result.question = {category:room.currentQuestion.category,question:room.currentQuestion.question,options:room.currentQuestion.options,correctIndex:room.currentQuestion.answer};
  }
  return result;
}
function send(res, data) { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); }
function broadcast(room) {
  for (const [res, playerId] of clients.get(room.code) || []) send(res, publicRoom(room, playerId));
}
function error(res, status, message) { json(res,status,{error:message}); }
function json(res,status,obj) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve,reject)=>{let body='';req.on('data',c=>{body+=c;if(body.length>1e6){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{try{resolve(body?JSON.parse(body):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);}); }
function getPlayer(room, token) { if(!token) return null; return [...room.players.values()].find(p=>p.token===token) || null; }
function touch(room) { room.updatedAt=Date.now(); }
function clearTimer(room) { if(room.timer){clearTimeout(room.timer);room.timer=null;} }
function makeQuestionDeck() {
  const deck=shuffle(QUESTIONS).slice(0,QUESTION_COUNT);
  const tie=shuffle(QUESTIONS.filter(q=>!deck.includes(q)))[0];
  return {deck,tie};
}
function scheduleQuestionEnd(room, ms=QUESTION_MS) {
  clearTimer(room);
  room.deadline=Date.now()+ms;
  room.timer=setTimeout(()=>endQuestion(room,'timeout'),ms);
}
function startQuestion(room) {
  clearTimer(room);
  if(room.questionIndex>=room.deck.length){finishOrTie(room);return;}
  room.phase='question'; room.currentQuestion=room.deck[room.questionIndex]; room.questionStartedAt=Date.now(); room.deadline=room.questionStartedAt+QUESTION_MS; room.lastResult=null;
  for(const p of room.players.values()){p.answer=null;p.answeredAt=null;p.lastPoints=0;}
  scheduleQuestionEnd(room,QUESTION_MS); touch(room); broadcast(room);
}
function scoreFor(elapsed) {
  const seconds=Math.max(0,elapsed)/1000;
  const bonus=seconds<=3?50:seconds<=6?40:seconds<=9?30:seconds<=12?20:10;
  return 100+bonus;
}
function endQuestion(room, reason) {
  if(room.phase!=='question') return;
  clearTimer(room);
  const q=room.currentQuestion;
  const rows=[];
  for(const p of room.players.values()){
    const correct=p.answer!==null && p.answer===q.answer;
    const points=correct?scoreFor(p.answeredAt-room.questionStartedAt):0;
    p.score+=points; p.lastPoints=points;
    rows.push({id:p.id,name:p.name,answer:p.answer,correct,points,total:p.score});
  }
  room.lastResult={correctIndex:q.answer,rows,reason};
  room.phase='reveal'; room.deadline=Date.now()+REVEAL_MS; touch(room); broadcast(room);
  room.timer=setTimeout(()=>{
    if(room.phase!=='reveal')return;
    room.questionIndex++;
    if(room.questionIndex>=room.deck.length) finishOrTie(room); else startQuestion(room);
  },REVEAL_MS);
}
function finishOrTie(room) {
  clearTimer(room);
  const scores=[...room.players.values()].map(p=>p.score);
  const max=Math.max(...scores);
  const leaders=[...room.players.values()].filter(p=>p.score===max);
  if(leaders.length>1 && !room.tieBreakUsed){
    room.tieBreakUsed=true; room.tieBreakRound=1; room.phase='question'; room.questionIndex=QUESTION_COUNT; room.currentQuestion=room.tieQuestion; room.questionStartedAt=Date.now(); room.lastResult=null;
    for(const p of room.players.values()){p.answer=null;p.answeredAt=null;p.lastPoints=0;}
    room.deadline=Date.now()+QUESTION_MS; room.tieBreak=true;
    scheduleQuestionEnd(room,QUESTION_MS); touch(room); broadcast(room); return;
  }
  room.phase='finished'; room.deadline=null;
  const finalScores=[...room.players.values()].sort((a,b)=>b.score-a.score);
  const top=finalScores[0]?.score;
  const winners=finalScores.filter(p=>p.score===top).map(p=>({id:p.id,name:p.name,score:p.score}));
  room.winner={winners,leaderboard:finalScores.map(p=>({id:p.id,name:p.name,score:p.score}))};
  touch(room); broadcast(room);
}
function roomResponse(room, player) { return {room:publicRoom(room,player.id),token:player.token,playerId:player.id}; }

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-Player-Token','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});return res.end();}
  if(url.pathname==='/api/health') return json(res,200,{ok:true,service:'quiz-arena',rooms:rooms.size,uptime:Math.round(process.uptime())});
  try {
    if(req.method==='POST' && url.pathname==='/api/rooms'){
      const body=await readBody(req); const name=safeName(body.name);
      if(name.length<2)return error(res,400,'Enter a player name with at least 2 characters.');
      let code; do{code=randomCode();}while(rooms.has(code));
      const player={id:randomId(9),token:randomId(24),name,avatar:crypto.randomInt(0,8),score:0,answer:null,answeredAt:null,connected:true,lastPoints:0};
      const {deck,tie}=makeQuestionDeck();
      const room={code,hostId:player.id,players:new Map([[player.id,player]]),phase:'waiting',questionIndex:0,deck,tieQuestion:tie,currentQuestion:null,questionStartedAt:null,deadline:null,timer:null,lastResult:null,winner:null,tieBreak:false,tieBreakUsed:false,tieBreakRound:0,createdAt:Date.now(),updatedAt:Date.now()};
      rooms.set(code,room); clients.set(code,new Set());
      return json(res,201,roomResponse(room,player));
    }
    if(req.method==='POST' && url.pathname==='/api/rooms/join'){
      const body=await readBody(req); const code=String(body.code||'').trim().toUpperCase(); const name=safeName(body.name);
      const room=rooms.get(code); if(!room)return error(res,404,'Room not found. Check the code and try again.');
      if(name.length<2)return error(res,400,'Enter a player name with at least 2 characters.');
      if(room.phase!=='waiting')return error(res,409,'This game has already started.');
      if(room.players.size>=MAX_PLAYERS)return error(res,409,'This room is full.');
      if([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))return error(res,409,'That player name is already taken in this room.');
      const player={id:randomId(9),token:randomId(24),name,avatar:crypto.randomInt(0,8),score:0,answer:null,answeredAt:null,connected:true,lastPoints:0};
      room.players.set(player.id,player);touch(room);broadcast(room);return json(res,201,roomResponse(room,player));
    }
    const roomMatch=url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(.*))?$/);
    if(roomMatch){
      const room=rooms.get(roomMatch[1]); if(!room)return error(res,404,'Room not found or expired.');
      const token=req.headers['x-player-token'] || url.searchParams.get('token'); const player=getPlayer(room,token);
      if(!player)return error(res,401,'Your player session was not found. Rejoin the room.');
      const action=roomMatch[2]||'';
      if(req.method==='GET' && action==='state')return json(res,200,publicRoom(room,player.id));
      if(req.method==='GET' && action==='events'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'*'});
        res.write('retry: 1500\n\n'); const set=clients.get(room.code)||new Set();set.add([res,player.id]);clients.set(room.code,set);player.connected=true;touch(room);send(res,publicRoom(room,player.id));
        const heartbeat=setInterval(()=>{if(!res.writableEnded)res.write(': heartbeat\n\n');},20000);
        res.on('close',()=>{clearInterval(heartbeat);set.delete([...set].find(x=>x[0]===res));player.connected=false;touch(room);broadcast(room);});return;
      }
      if(req.method==='POST' && action==='start'){
        if(player.id!==room.hostId)return error(res,403,'Only the host can start the game.');
        if(room.phase!=='waiting')return error(res,409,'The game has already started.');
        if(room.players.size<2)return error(res,409,'At least 2 players are required to start.');
        startQuestion(room);return json(res,200,{ok:true,room:publicRoom(room,player.id)});
      }
      if(req.method==='POST' && action==='answer'){
        const body=await readBody(req);
        if(room.phase!=='question')return error(res,409,'This question is no longer accepting answers.');
        if(Date.now()>room.deadline){endQuestion(room,'timeout');return error(res,409,'Time is up.');}
        if(player.answer!==null)return error(res,409,'Your answer is already locked.');
        const answer=Number(body.answer);
        if(!Number.isInteger(answer)||answer<0||answer>3)return error(res,400,'Select one of the four answers.');
        player.answer=answer;player.answeredAt=Date.now();touch(room);broadcast(room);
        if([...room.players.values()].every(p=>p.answer!==null))endQuestion(room,'all-answered');
        return json(res,200,{ok:true});
      }
      if(req.method==='POST' && action==='leave'){
        if(room.phase==='waiting'){
          room.players.delete(player.id);
          if(player.id===room.hostId){const next=room.players.values().next().value;if(next)room.hostId=next.id;else{clearTimer(room);rooms.delete(room.code);clients.delete(room.code);return json(res,200,{ok:true,closed:true});}}
          touch(room);broadcast(room);
        } else { player.connected=false;touch(room);broadcast(room); }
        return json(res,200,{ok:true});
      }
    }
  } catch(e) { console.error(e); return error(res,400,e.message||'Request failed.'); }
  if(req.method==='GET'){
    let pathname=decodeURIComponent(url.pathname); if(pathname==='/')pathname='/index.html';
    const file=path.normalize(path.join(PUBLIC,pathname));
    if(!file.startsWith(PUBLIC))return error(res,403,'Forbidden');
    fs.readFile(file,(err,data)=>{if(err)return error(res,404,'Not found');res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':path.extname(file)==='.html'?'no-cache':'public, max-age=3600'});res.end(data);});return;
  }
  error(res,404,'Not found');
});

setInterval(()=>{for(const [code,room] of rooms){if(Date.now()-room.updatedAt>ROOM_TTL){clearTimer(room);for(const [res] of clients.get(code)||[])res.end();clients.delete(code);rooms.delete(code);}}},60_000).unref();
server.listen(PORT,HOST,()=>console.log(`QUIZ ARENA running on http://${HOST}:${PORT}`));
