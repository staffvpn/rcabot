-- migrations/0005_add_ephemeral_messages.sql
-- Tracks each user's last "browsing" message (Инструкции navigation, admin panel) so it can be
-- deleted right before the next one is sent — keeps the chat down to shift reports and
-- notifications, which never go through this table.
create table ephemeral_messages (
  telegram_id integer primary key,
  chat_id integer not null,
  message_id integer not null
);
