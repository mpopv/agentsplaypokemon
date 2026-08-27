from __future__ import annotations

import unittest

import pokemon_red


class PokemonRedPartyTest(unittest.TestCase):
    def test_treats_uninitialized_zero_count_memory_as_an_empty_party(self) -> None:
        snapshot = pokemon_red.read_party([0] * 0x10000)

        self.assertEqual(snapshot, {"available": True, "party": []})

    def test_reads_party_identity_stats_and_nickname(self) -> None:
        memory = make_memory()
        add_member(memory, 0, 0x54, "SPARKY", level=18, hp=37, max_hp=45)

        snapshot = pokemon_red.read_party(memory)

        self.assertTrue(snapshot["available"])
        self.assertEqual(
            snapshot["party"],
            [
                {
                    "slot": 1,
                    "nickname": "SPARKY",
                    "species": "PIKACHU",
                    "pokedexNumber": 25,
                    "level": 18,
                    "hp": 37,
                    "maxHp": 45,
                    "status": "OK",
                    "active": False,
                    "fainted": False,
                }
            ],
        )

    def test_overlays_active_battle_hp_and_status(self) -> None:
        memory = make_memory()
        add_member(memory, 0, 0xB0, "EMBER", level=9, hp=28, max_hp=30)
        memory[pokemon_red.BATTLE_STATE_ADDRESS] = 1
        memory[pokemon_red.PLAYER_MON_NUMBER_ADDRESS] = 0
        battle = pokemon_red.BATTLE_MON_ADDRESS
        memory[battle] = 0xB0
        write_u16(memory, battle + pokemon_red.BATTLE_MON_HP_OFFSET, 12)
        memory[battle + pokemon_red.BATTLE_MON_STATUS_OFFSET] = 1 << 3
        memory[battle + pokemon_red.BATTLE_MON_LEVEL_OFFSET] = 9
        write_u16(memory, battle + pokemon_red.BATTLE_MON_MAX_HP_OFFSET, 30)

        member = pokemon_red.read_party(memory)["party"][0]

        self.assertEqual(member["hp"], 12)
        self.assertEqual(member["status"], "PSN")
        self.assertTrue(member["active"])

    def test_fainted_status_wins_over_the_raw_status_byte(self) -> None:
        memory = make_memory()
        add_member(memory, 0, 0x99, "BULBY", level=5, hp=0, max_hp=20, status=1 << 6)

        member = pokemon_red.read_party(memory)["party"][0]

        self.assertEqual(member["status"], "FNT")
        self.assertTrue(member["fainted"])

    def test_rejects_a_transient_or_corrupt_party(self) -> None:
        memory = make_memory()
        memory[pokemon_red.PARTY_COUNT_ADDRESS] = 1
        memory[pokemon_red.PARTY_SPECIES_ADDRESS] = 0x54

        with self.assertRaises(pokemon_red.PartyDataError):
            pokemon_red.read_party(memory)

    def test_has_all_151_normal_species_for_sprite_lookup(self) -> None:
        self.assertEqual(len(pokemon_red.SPECIES_BY_INTERNAL_ID), 151)
        self.assertEqual(pokemon_red.SPECIES_BY_INTERNAL_ID[0x99], (1, "BULBASAUR"))
        self.assertEqual(pokemon_red.SPECIES_BY_INTERNAL_ID[0x15], (151, "MEW"))


def make_memory() -> list[int]:
    memory = [0] * 0x10000
    memory[pokemon_red.PARTY_SPECIES_ADDRESS] = 0xFF
    return memory


def add_member(
    memory: list[int],
    index: int,
    species: int,
    nickname: str,
    *,
    level: int,
    hp: int,
    max_hp: int,
    status: int = 0,
) -> None:
    count = max(memory[pokemon_red.PARTY_COUNT_ADDRESS], index + 1)
    memory[pokemon_red.PARTY_COUNT_ADDRESS] = count
    memory[pokemon_red.PARTY_SPECIES_ADDRESS + index] = species
    memory[pokemon_red.PARTY_SPECIES_ADDRESS + count] = 0xFF

    address = pokemon_red.PARTY_STRUCT_ADDRESS + index * pokemon_red.PARTY_STRUCT_LENGTH
    memory[address] = species
    write_u16(memory, address + pokemon_red.MON_HP_OFFSET, hp)
    memory[address + pokemon_red.MON_STATUS_OFFSET] = status
    memory[address + pokemon_red.MON_LEVEL_OFFSET] = level
    write_u16(memory, address + pokemon_red.MON_MAX_HP_OFFSET, max_hp)

    encoded = [0x80 + ord(character) - ord("A") for character in nickname]
    encoded.append(0x50)
    name_address = pokemon_red.PARTY_NICKNAMES_ADDRESS + index * pokemon_red.NAME_LENGTH
    memory[name_address : name_address + len(encoded)] = encoded


def write_u16(memory: list[int], address: int, value: int) -> None:
    memory[address] = value >> 8
    memory[address + 1] = value & 0xFF


if __name__ == "__main__":
    unittest.main()
