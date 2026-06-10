-- Up migration

CREATE TABLE accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

CREATE TABLE zones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  asset_key       TEXT NOT NULL,
  spawn_x         FLOAT NOT NULL DEFAULT 0,
  spawn_y         FLOAT NOT NULL DEFAULT 0,
  spawn_z         FLOAT NOT NULL DEFAULT 0
);

CREATE TABLE characters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT UNIQUE NOT NULL,
  level           INT NOT NULL DEFAULT 1,
  xp              BIGINT NOT NULL DEFAULT 0,
  hp              INT NOT NULL,
  max_hp          INT NOT NULL,
  mp              INT NOT NULL,
  max_mp          INT NOT NULL,
  strength        INT NOT NULL DEFAULT 10,
  dexterity       INT NOT NULL DEFAULT 10,
  intelligence    INT NOT NULL DEFAULT 10,
  zone_id         UUID NOT NULL REFERENCES zones(id),
  pos_x           FLOAT NOT NULL DEFAULT 0,
  pos_y           FLOAT NOT NULL DEFAULT 0,
  pos_z           FLOAT NOT NULL DEFAULT 0,
  rotation        FLOAT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ
);

CREATE INDEX ON characters(account_id);

CREATE TYPE item_type   AS ENUM ('weapon', 'armor', 'consumable', 'quest', 'misc');
CREATE TYPE item_rarity AS ENUM ('common', 'uncommon', 'rare', 'epic', 'legendary');

CREATE TABLE item_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  type            item_type NOT NULL,
  rarity          item_rarity NOT NULL DEFAULT 'common',
  asset_key       TEXT,
  stackable       BOOL NOT NULL DEFAULT false,
  max_stack       INT NOT NULL DEFAULT 1,
  properties      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX ON item_templates USING gin(properties);

CREATE TABLE inventory_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  template_id     UUID NOT NULL REFERENCES item_templates(id),
  quantity        INT NOT NULL DEFAULT 1,
  slot            TEXT,
  properties      JSONB NOT NULL DEFAULT '{}',
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON inventory_items(character_id);
CREATE UNIQUE INDEX ON inventory_items(character_id, slot) WHERE slot IS NOT NULL;

CREATE TABLE quest_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  objectives      JSONB NOT NULL DEFAULT '[]',
  rewards         JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE character_quests (
  character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id        UUID NOT NULL REFERENCES quest_templates(id),
  status          TEXT NOT NULL DEFAULT 'active',
  progress        JSONB NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (character_id, quest_id)
);
