import { pool } from "./db.js";
import {
  addProduct,
  placeOrder,
  updateCustomerEmail,
  withClient,
} from "./scenarios.js";

async function main(): Promise<void> {
  console.log("Подключение к БД…");

  const customerId = 1;

  const orderId = await withClient(pool, (c) =>
    placeOrder(c, customerId, [
      { productId: 1, quantity: 2 },
      { productId: 2, quantity: 1 },
    ])
  );
  const orderRow = await pool.query(
    `SELECT order_id, customer_id, total_amount::text AS total_amount
     FROM orders WHERE order_id = $1`,
    [orderId]
  );
  console.log("\nСценарий 1 — заказ создан:", orderRow.rows[0]);

  const items = await pool.query(
    `SELECT order_item_id, product_id, quantity, subtotal::text AS subtotal
     FROM order_items WHERE order_id = $1 ORDER BY order_item_id`,
    [orderId]
  );
  console.log("Позиции заказа:", items.rows);

  await withClient(pool, (c) =>
    updateCustomerEmail(c, customerId, "ivan.new@example.com")
  );
  const cust = await pool.query(
    `SELECT customer_id, email FROM customers WHERE customer_id = $1`,
    [customerId]
  );
  console.log("\nСценарий 2 — email обновлён:", cust.rows[0]);

  const productId = await withClient(pool, (c) =>
    addProduct(c, "Наушники", 4999.99)
  );
  const prod = await pool.query(
    `SELECT product_id, product_name, price::text AS price FROM products WHERE product_id = $1`,
    [productId]
  );
  console.log("\nСценарий 3 — продукт добавлен:", prod.rows[0]);

  console.log("\nГотово.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
