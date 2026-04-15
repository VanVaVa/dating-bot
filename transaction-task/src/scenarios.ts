import type { Pool, PoolClient } from "pg";

export type OrderLineInput = {
  productId: number;
  quantity: number;
};

/**
 * Сценарий 1: размещение заказа в одной транзакции:
 * заказ → позиции с subtotal → пересчёт total_amount.
 */
export async function placeOrder(
  client: PoolClient,
  customerId: number,
  lines: OrderLineInput[]
): Promise<number> {
  await client.query("BEGIN");
  try {
    const orderInsert = await client.query<{ order_id: number }>(
      `INSERT INTO orders (customer_id, order_date, total_amount)
       VALUES ($1, NOW(), 0)
       RETURNING order_id`,
      [customerId]
    );
    const orderId = orderInsert.rows[0].order_id;

    for (const line of lines) {
      const priceRes = await client.query<{ price: string }>(
        `SELECT price::text AS price FROM products WHERE product_id = $1 FOR UPDATE`,
        [line.productId]
      );
      if (priceRes.rowCount === 0) {
        throw new Error(`Товар ${line.productId} не найден`);
      }
      const unit = Number(priceRes.rows[0].price);
      const subtotal = unit * line.quantity;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, subtotal)
         VALUES ($1, $2, $3, $4)`,
        [orderId, line.productId, line.quantity, subtotal]
      );
    }

    await client.query(
      `UPDATE orders
       SET total_amount = COALESCE(
         (SELECT SUM(subtotal) FROM order_items WHERE order_id = $1),
         0
       )
       WHERE order_id = $1`,
      [orderId]
    );

    await client.query("COMMIT");
    return orderId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Сценарий 2: атомарное обновление email клиента.
 */
export async function updateCustomerEmail(
  client: PoolClient,
  customerId: number,
  newEmail: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    const res = await client.query(
      `UPDATE customers SET email = $1 WHERE customer_id = $2`,
      [newEmail, customerId]
    );
    if (res.rowCount === 0) {
      throw new Error(`Клиент ${customerId} не найден`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Сценарий 3: атомарное добавление нового продукта.
 */
export async function addProduct(
  client: PoolClient,
  name: string,
  price: number
): Promise<number> {
  await client.query("BEGIN");
  try {
    const res = await client.query<{ product_id: number }>(
      `INSERT INTO products (product_name, price)
       VALUES ($1, $2)
       RETURNING product_id`,
      [name, price]
    );
    const productId = res.rows[0].product_id;
    await client.query("COMMIT");
    return productId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Удобная обёртка: взять клиент из пула и выполнить fn в транзакции (если fn сама не BEGIN). */
export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
