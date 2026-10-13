import prisma from '../src/lib/prisma';

async function check() {
  const tables = ['sports_clubs', 'sports_shop_products', 'sports_travel_vans'];
  for (const t of tables) {
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE table_name = '${t}';
    `);
    console.log(`Table ${t}:`, cols);
  }
  await prisma.$disconnect();
}

check();
