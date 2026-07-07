import { app } from './middlelayer/app';
import { app1 } from './backend/app1';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5000', 10);
const PORT1 = parseInt(process.env.PORT1 || '5001', 10);

//middleware layer of backend server

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 middle Server running at http://localhost:${PORT}`);
});

//backend server

app1.listen(PORT1, '0.0.0.0', () => {
  console.log(`🚀 backend Server running at http://localhost:${PORT1}`);
});
