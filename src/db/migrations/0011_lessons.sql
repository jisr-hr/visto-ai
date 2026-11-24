alter table visto_ai.memory_records add column lesson text;

create table visto_ai.reply_verdicts (
  service text not null, owner text not null, repo text not null, number integer not null,
  reply text not null,
  finding text not null,
  classification text check (classification in ('confirmed_fix', 'valid_pushback', 'invalid_pushback', 'question', 'noise')),
  outcome text not null,
  attempts integer not null default 0,
  judged_at timestamptz not null,
  primary key (service, reply)
);
create index reply_verdicts_lessons on visto_ai.reply_verdicts (judged_at) where outcome = 'lesson';

create table visto_ai.judge_calls (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  reply text not null,
  at timestamptz not null,
  calls integer not null, input_tokens integer not null, output_tokens integer not null, cached_tokens integer not null,
  cost double precision not null
);
create index judge_calls_at on visto_ai.judge_calls (at);
