import type {
  PokemonPartyMember,
  PokemonPartySnapshot
} from "../../shared/types";

const PARTY_SIZE = 6;
const SPRITE_BASE_URL =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-i/red-blue";

interface PokemonPartyPanelProps {
  snapshot: PokemonPartySnapshot | null;
}

export function PokemonPartyPanel({ snapshot }: PokemonPartyPanelProps) {
  const slots = Array.from({ length: PARTY_SIZE }, (_, index) =>
    snapshot?.party.find((member) => member.slot === index + 1)
  );

  return (
    <section className="pokemon-party-panel" aria-label="Current Pokémon party">
      <div className="pokemon-party-grid">
        {slots.map((member, index) =>
          member ? (
            <PartyCard member={member} key={`slot-${member.slot}`} />
          ) : (
            <EmptyPartyCard
              key={`slot-${index + 1}`}
              slot={index + 1}
              waiting={snapshot === null || !snapshot.available}
            />
          )
        )}
      </div>
    </section>
  );
}

function PartyCard({ member }: { member: PokemonPartyMember }) {
  const hpPercent = Math.max(0, Math.min(100, (member.hp / member.maxHp) * 100));
  const xpToNextLevel = member.xpNeededThisLevel - member.xpEarnedThisLevel;
  const xpPercent =
    member.level === 100
      ? 100
      : (member.xpEarnedThisLevel / member.xpNeededThisLevel) * 100;
  const hpTone = hpPercent <= 20 ? "danger" : hpPercent <= 50 ? "warning" : "healthy";
  const classes = [
    "pokemon-party-card",
    member.active ? "is-active" : "",
    member.fainted ? "is-fainted" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={classes}
      aria-label={`Party slot ${member.slot}: ${member.nickname}, ${member.species}, level ${member.level}, ${member.hp} of ${member.maxHp} HP, status ${member.status}, ${member.level === 100 ? "maximum level" : `${xpToNextLevel} XP to next level`}`}
    >
      <div className="pokemon-card-header">
        <span>SLOT {String(member.slot).padStart(2, "0")}</span>
        {member.active ? <span className="active-badge">ACTIVE</span> : null}
        <span className={`pokemon-status status-${member.status.toLowerCase()}`}>
          {member.status}
        </span>
      </div>
      <div className="pokemon-card-body">
        <img
          className="pokemon-sprite"
          src={`${SPRITE_BASE_URL}/${member.pokedexNumber}.png`}
          alt={`${member.species} sprite`}
          decoding="async"
          loading="eager"
          referrerPolicy="no-referrer"
        />
        <div className="pokemon-identity">
          <strong title={member.nickname}>{member.nickname}</strong>
          <span title={member.species}>{member.species}</span>
          <b>LV {member.level}</b>
        </div>
      </div>
      <div className="pokemon-vitals">
        <div className="pokemon-hp">
          <div className="pokemon-meter-label">
            <span>HP</span>
            <strong>{member.hp}/{member.maxHp}</strong>
          </div>
          <div className="pokemon-hp-meter" aria-hidden="true">
            <span className={`is-${hpTone}`} style={{ width: `${hpPercent}%` }} />
          </div>
        </div>
        <div className="pokemon-xp">
          <div className="pokemon-meter-label">
            <span>XP</span>
            <strong>{member.level === 100 ? "MAX" : `${xpToNextLevel} TO NEXT`}</strong>
          </div>
          <div
            className="pokemon-xp-meter"
            role="progressbar"
            aria-label={member.level === 100 ? "Maximum level" : "Experience to next level"}
            aria-valuemin={0}
            aria-valuemax={member.level === 100 ? 100 : member.xpNeededThisLevel}
            aria-valuenow={member.level === 100 ? 100 : member.xpEarnedThisLevel}
          >
            <span style={{ width: `${xpPercent}%` }} />
          </div>
        </div>
      </div>
    </article>
  );
}

function EmptyPartyCard({ slot, waiting }: { slot: number; waiting: boolean }) {
  return (
    <article className="pokemon-party-card is-empty" aria-label={`Party slot ${slot} is empty`}>
      <div className="pokemon-card-header">
        <span>SLOT {String(slot).padStart(2, "0")}</span>
      </div>
      <div className="empty-party-mark" aria-hidden="true">—</div>
      <span>{waiting ? "WAITING FOR ROM DATA" : "EMPTY PARTY SLOT"}</span>
    </article>
  );
}
