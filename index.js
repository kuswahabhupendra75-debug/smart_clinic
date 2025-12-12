const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
global.io = io;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const db = new sqlite3.Database('clinic.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT, address TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE)`);
  db.run(`CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, name TEXT, username TEXT UNIQUE, password TEXT, branch_id TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, patient_id TEXT, branch_id TEXT, token_number INTEGER, status TEXT, created_at TEXT, no_show_count INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, patient_id TEXT, visit_date TEXT, reason TEXT, notes TEXT, doctor_id TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS medicines (id TEXT PRIMARY KEY, visit_id TEXT, medicine_name TEXT, dosage TEXT, duration_days INTEGER)`);
  db.get('SELECT COUNT(*) as c FROM branches', (e,r) => {
    if(r && r.c === 0) {
      const { v4: uuid } = require('uuid');
      db.run('INSERT INTO branches (id,name,address) VALUES (?,?,?)', [uuid(), 'Divine Clinic - Branch A', 'Address A']);
      db.run('INSERT INTO branches (id,name,address) VALUES (?,?,?)', [uuid(), 'Divine Clinic - Branch B', 'Address B']);
    }
  });
});

// helper
function sendError(res, msg){ res.status(400).json({ error: msg }); }

// patients
app.post('/api/patients/findOrCreate', (req, res) => {
  const { name, phone } = req.body;
  if(!phone) return sendError(res, 'phone required');
  db.get('SELECT * FROM patients WHERE phone=?', [phone], (e,row) => {
    if(row) return res.json(row);
    const { v4: uuid } = require('uuid');
    const id = uuid();
    db.run('INSERT INTO patients(id,name,phone) VALUES(?,?,?)', [id,name,phone], () => res.json({ id, name, phone }));
  });
});

app.get('/api/patients/:id/history', (req, res) => {
  const pid = req.params.id;
  db.all('SELECT * FROM history WHERE patient_id=? ORDER BY visit_date DESC', [pid], (e,visits) => {
    if(!visits) return res.json([]);
    let pending = visits.length;
    visits.forEach((v, idx) => {
      db.all('SELECT * FROM medicines WHERE visit_id=?', [v.id], (err, meds) => {
        visits[idx].medicines = meds || [];
        pending--; if(pending===0) res.json(visits);
      });
    });
  });
});

// branches
app.get('/api/branches', (req,res) => {
  db.all('SELECT * FROM branches', [], (e,rows) => res.json(rows));
});

// tokens
app.post('/api/tokens/book', (req,res) => {
  const { branch_id, patient_id } = req.body;
  if(!branch_id||!patient_id) return sendError(res, 'branch_id and patient_id required');
  const { v4: uuid } = require('uuid');
  const id = uuid();
  db.get('SELECT token_number FROM tokens WHERE branch_id=? ORDER BY created_at DESC LIMIT 1', [branch_id], (e, row) => {
    const nextNum = row ? row.token_number + 1 : 1;
    db.run('INSERT INTO tokens(id,patient_id,branch_id,token_number,status,created_at) VALUES(?,?,?,?,?,datetime("now"))', [id,patient_id,branch_id,nextNum,'waiting'], () => {
      const eta = 10;
      io.to('branch_'+branch_id).emit('queue_update', { action:'booked' });
      res.json({ token_id: id, token_number: nextNum, eta_minutes: eta });
    });
  });
});

app.post('/api/tokens/:id/checkin', (req,res) => {
  const id = req.params.id;
  db.run('UPDATE tokens SET status="checked_in" WHERE id=?', [id], () => {
    io.emit('queue_update'); res.json({ ok:true });
  });
});

app.post('/api/tokens/served', (req,res) => {
  const { token_id } = req.body;
  if(!token_id) return sendError(res,'token_id required');
  db.run('UPDATE tokens SET status="served" WHERE id=?', [token_id], () => {
    io.emit('token_served', { token_id }); res.json({ ok:true });
  });
});

app.post('/api/tokens/call_next', (req,res) => {
  const { branch_id } = req.body;
  db.get('SELECT * FROM tokens WHERE branch_id=? AND status="waiting" ORDER BY created_at ASC LIMIT 1', [branch_id], (e,row) => {
    if(!row) return res.json({ message:'No waiting patients' });
    db.run('UPDATE tokens SET status="called" WHERE id=?', [row.id], () => {
      io.to('branch_'+branch_id).emit('token_called', row); res.json(row);
    });
  });
});

app.get('/api/tokens/branch/:id/list', (req,res) => {
  const bid = req.params.id;
  db.all('SELECT * FROM tokens WHERE branch_id=? ORDER BY created_at ASC', [bid], (e,rows) => res.json({ tokens: rows }));
});

app.get('/api/tokens/qr/checkin/:tokenId', async (req,res) => {
  const token = req.params.tokenId;
  const QRCode = require('qrcode');
  const data = await QRCode.toDataURL(token);
  const img = Buffer.from(data.split(',')[1], 'base64');
  res.writeHead(200, { 'Content-Type':'image/png', 'Content-Length': img.length }); res.end(img);
});

// history/medicines
app.post('/api/history/add', (req,res) => {
  const { patient_id, reason, notes, doctor_id } = req.body;
  const { v4: uuid } = require('uuid'); const id = uuid();
  db.run('INSERT INTO history(id,patient_id,visit_date,reason,notes,doctor_id) VALUES(?,?,datetime("now"),?,?,?)', [id,patient_id,reason,notes,doctor_id], () => res.json({ id }));
});

app.post('/api/medicines/add', (req,res) => {
  const { visit_id, medicine_name, dosage, duration_days } = req.body;
  const { v4: uuid } = require('uuid'); const id = uuid();
  db.run('INSERT INTO medicines(id,visit_id,medicine_name,dosage,duration_days) VALUES(?,?,?,?,?)', [id,visit_id,medicine_name,dosage,duration_days], () => res.json({ id }));
});

// doctor login
app.post('/api/doctors/login', (req,res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM doctors WHERE username=? AND password=?', [username,password], (e,row) => {
    if(!row) return res.status(401).json({ error:'Invalid credentials' });
    res.json(row);
  });
});

// admin stats
app.get('/api/admin/stats', (req,res) => {
  db.get('SELECT COUNT(*) as total_patients FROM patients', [], (e,r1) => {
    db.get('SELECT COUNT(*) as total_tokens FROM tokens', [], (e,r2) => {
      db.get('SELECT COUNT(*) as served FROM tokens WHERE status="served"', [], (e,r3) => {
        db.get('SELECT COUNT(*) as waiting FROM tokens WHERE status="waiting"', [], (e,r4) => {
          res.json({ total_patients: r1.total_patients, total_tokens: r2.total_tokens, served: r3.served, waiting: r4.waiting });
        });
      });
    });
  });
});

io.on('connection', socket => {
  socket.on('join_branch', branchId => { socket.join('branch_'+branchId); });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log('Smart Clinic backend running on port', PORT));
