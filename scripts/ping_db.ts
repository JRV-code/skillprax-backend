import prisma from '../src/lib/prisma';

async function testConnection() {
  console.log('Testing connection to Render DB...');
  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`Attempt ${i}...`);
      const res = await prisma.$queryRawUnsafe('SELECT 1 as connected;');
      console.log('Connection successful:', res);
      await prisma.$disconnect();
      return true;
    } catch (err: any) {
      console.log(`Attempt ${i} failed:`, err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  await prisma.$disconnect();
  return false;
}

testConnection().then(ok => {
  process.exit(ok ? 0 : 1);
});
