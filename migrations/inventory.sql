CREATE TABLE inventory (
  sku text PRIMARY KEY, name text NOT NULL, price int NOT NULL CHECK(price>0),
  available int NOT NULL CHECK(available>=0), reserved int NOT NULL DEFAULT 0 CHECK(reserved>=0),
  version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reservations (
  order_id uuid PRIMARY KEY, items jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('RESERVED','REJECTED','RELEASED','CONSUMED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO inventory(sku,name,price,available) VALUES
 ('NF-KB-001','Mechanical Keyboard',14900,428),('NF-HB-002','USB-C Docking Hub',7900,862),
 ('NF-MN-003','Studio Monitor',32900,156),('NF-HP-004','Wireless Headphones',19900,305);
