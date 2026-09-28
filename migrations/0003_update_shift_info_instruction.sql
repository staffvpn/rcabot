-- migrations/0003_update_shift_info_instruction.sql
-- "Информация по смене" body was thin (2 counter types); quickresto.ru/support's dedicated
-- article on this section lists three. Updated to match.
update instructions
set body = 'В разделе «Информация по смене» доступны три типа счётчиков:

Фискальные счётчики — суммы по фискальным оплатам и возвратам, проведённым на фискальном регистраторе.

Вычислимые счётчики — суммы по фискальным и нефискальным оплатам вместе.

Нефискальные счётчики — суммы по нефискальным оплатам (например, бонусами) и возвратам по ним.'
where id = 'seed-instr-7';
