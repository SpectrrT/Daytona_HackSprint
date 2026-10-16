-- The attack tree in SurrealDB (M1). Owner: Ryan.
-- Nodes: attack, world, lesson. Edges: mutated_into (attack→attack), hit_by (world→attack),
-- protects (lesson→attack). Schemaless for hackathon speed; tighten if time allows.

DEFINE TABLE IF NOT EXISTS attack SCHEMALESS;
DEFINE TABLE IF NOT EXISTS world SCHEMALESS;
DEFINE TABLE IF NOT EXISTS lesson SCHEMALESS;
DEFINE TABLE IF NOT EXISTS mutated_into TYPE RELATION FROM attack TO attack;
DEFINE TABLE IF NOT EXISTS hit_by TYPE RELATION FROM world TO attack;
DEFINE TABLE IF NOT EXISTS protects TYPE RELATION FROM lesson TO attack;

DEFINE INDEX IF NOT EXISTS lesson_attack ON lesson FIELDS attack_id;

-- Handy for the demo (Surrealist): the whole tree with lessons hanging off each branch
-- SELECT id, family, type, ->mutated_into->attack AS children, <-protects<-lesson.text AS lessons FROM attack;
