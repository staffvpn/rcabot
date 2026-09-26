-- migrations/0001_init.sql
create table employees (
  id text primary key,
  telegram_id integer unique not null,
  full_name text not null,
  active integer not null default 1,
  created_at text not null default (datetime('now'))
);

create table admins (
  id text primary key,
  telegram_id integer unique not null,
  full_name text not null,
  created_at text not null default (datetime('now'))
);

create table schedule (
  weekday integer primary key check (weekday between 0 and 6), -- 0 = Monday .. 6 = Sunday
  opens_at text not null,
  closes_at text not null
);

create table checklist_items (
  id text primary key,
  phase text not null check (phase in ('open','close')),
  position integer not null,
  label text not null,
  requires_photo integer not null default 0
);

create table instructions (
  id text primary key,
  position integer not null,
  title text not null,
  body text not null,
  media_url text
);

create table expiry_items (
  id text primary key,
  position integer not null,
  name text not null,
  shelf_life_days integer not null
);

create table shifts (
  id text primary key,
  employee_id text not null references employees(id),
  shift_date text not null,
  opened_at text,
  closed_at text,
  open_cash_amount real,
  closing_float_amount real,
  cash_discrepancy real,
  xreport_cash real,
  xreport_cashless real,
  xreport_at text,
  status text not null default 'pending' check (status in ('pending','open','closed')),
  reminded_open_at text,
  notified_late_at text,
  reminded_close_at text,
  reminded_xreport_at text,
  unique (employee_id, shift_date)
);

create table shift_checklist_progress (
  id text primary key,
  shift_id text not null references shifts(id) on delete cascade,
  checklist_item_id text not null references checklist_items(id) on delete cascade,
  done integer not null default 0,
  photo_file_id text,
  unique (shift_id, checklist_item_id)
);

create table bot_sessions (
  telegram_id integer primary key,
  state text,
  data text not null default '{}',
  updated_at text not null default (datetime('now'))
);

-- seed: schedule (Mon-Fri 08:30-19:30, Sat 09:00-19:00, Sun 09:00-18:00)
insert into schedule (weekday, opens_at, closes_at) values
  (0,'08:30','19:30'), (1,'08:30','19:30'), (2,'08:30','19:30'),
  (3,'08:30','19:30'), (4,'08:30','19:30'),
  (5,'09:00','19:00'),
  (6,'09:00','18:00');

-- seed: default checklists
insert into checklist_items (id, phase, position, label, requires_photo) values
  ('seed-open-1', 'open', 1, 'Кофемашина прогрета', 0),
  ('seed-open-2', 'open', 2, 'Терминал включён', 0),
  ('seed-open-3', 'open', 3, 'Зал чистый', 0),
  ('seed-close-1', 'close', 1, 'Фото отчёта с кассы', 1);

-- seed: expiry list from the client's dessert shelf-life sheet
insert into expiry_items (id, position, name, shelf_life_days) values
  ('seed-exp-1',1,'Канеле',2), ('seed-exp-2',2,'Пирог миндаль',5), ('seed-exp-3',3,'Чизкейк',3),
  ('seed-exp-4',4,'Пирог смородина',5), ('seed-exp-5',5,'Пирог вишня',5), ('seed-exp-6',6,'Тарт лимонный',3),
  ('seed-exp-7',7,'Кексы',5), ('seed-exp-8',8,'Наполеон',5), ('seed-exp-9',9,'Медовик',5), ('seed-exp-10',10,'Картошка',5);
