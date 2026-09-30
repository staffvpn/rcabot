-- migrations/0006_add_schedule_assignments.sql
-- Who's actually scheduled to work which day — drives cron reminder/lateness targeting.
-- No unique constraint on (employee_id, shift_date): the admin editor enforces one row per
-- pair at the app level (upsertScheduleAssignment replaces, never duplicates).
create table schedule_assignments (
  id text primary key,
  employee_id text not null references employees(id),
  shift_date text not null,
  start_time text not null,
  end_time text not null
);
