from __future__ import annotations

from typing import Any, Protocol


SUPPORTED_ROM_SHA256 = "5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b"

PARTY_COUNT_ADDRESS = 0xD163
PARTY_SPECIES_ADDRESS = 0xD164
PARTY_STRUCT_ADDRESS = 0xD16B
PARTY_NICKNAMES_ADDRESS = 0xD2B5
PARTY_LENGTH = 6
PARTY_STRUCT_LENGTH = 0x2C
NAME_LENGTH = 11

BATTLE_STATE_ADDRESS = 0xD057
PLAYER_MON_NUMBER_ADDRESS = 0xCC2F
BATTLE_MON_ADDRESS = 0xD014

MON_HP_OFFSET = 1
MON_STATUS_OFFSET = 4
MON_LEVEL_OFFSET = 33
MON_MAX_HP_OFFSET = 34

BATTLE_MON_HP_OFFSET = 1
BATTLE_MON_STATUS_OFFSET = 4
BATTLE_MON_LEVEL_OFFSET = 14
BATTLE_MON_MAX_HP_OFFSET = 15


class PartyDataError(ValueError):
    pass


class MemoryView(Protocol):
    def __getitem__(self, key: int | slice) -> int | list[int]: ...


SPECIES_BY_INTERNAL_ID = {
    0x01: (112, "RHYDON"),
    0x02: (115, "KANGASKHAN"),
    0x03: (32, "NIDORAN♂"),
    0x04: (35, "CLEFAIRY"),
    0x05: (21, "SPEAROW"),
    0x06: (100, "VOLTORB"),
    0x07: (34, "NIDOKING"),
    0x08: (80, "SLOWBRO"),
    0x09: (2, "IVYSAUR"),
    0x0A: (103, "EXEGGUTOR"),
    0x0B: (108, "LICKITUNG"),
    0x0C: (102, "EXEGGCUTE"),
    0x0D: (88, "GRIMER"),
    0x0E: (94, "GENGAR"),
    0x0F: (29, "NIDORAN♀"),
    0x10: (31, "NIDOQUEEN"),
    0x11: (104, "CUBONE"),
    0x12: (111, "RHYHORN"),
    0x13: (131, "LAPRAS"),
    0x14: (59, "ARCANINE"),
    0x15: (151, "MEW"),
    0x16: (130, "GYARADOS"),
    0x17: (90, "SHELLDER"),
    0x18: (72, "TENTACOOL"),
    0x19: (92, "GASTLY"),
    0x1A: (123, "SCYTHER"),
    0x1B: (120, "STARYU"),
    0x1C: (9, "BLASTOISE"),
    0x1D: (127, "PINSIR"),
    0x1E: (114, "TANGELA"),
    0x21: (58, "GROWLITHE"),
    0x22: (95, "ONIX"),
    0x23: (22, "FEAROW"),
    0x24: (16, "PIDGEY"),
    0x25: (79, "SLOWPOKE"),
    0x26: (64, "KADABRA"),
    0x27: (75, "GRAVELER"),
    0x28: (113, "CHANSEY"),
    0x29: (67, "MACHOKE"),
    0x2A: (122, "MR. MIME"),
    0x2B: (106, "HITMONLEE"),
    0x2C: (107, "HITMONCHAN"),
    0x2D: (24, "ARBOK"),
    0x2E: (47, "PARASECT"),
    0x2F: (54, "PSYDUCK"),
    0x30: (96, "DROWZEE"),
    0x31: (76, "GOLEM"),
    0x33: (126, "MAGMAR"),
    0x35: (125, "ELECTABUZZ"),
    0x36: (82, "MAGNETON"),
    0x37: (109, "KOFFING"),
    0x39: (56, "MANKEY"),
    0x3A: (86, "SEEL"),
    0x3B: (50, "DIGLETT"),
    0x3C: (128, "TAUROS"),
    0x40: (83, "FARFETCH'D"),
    0x41: (48, "VENONAT"),
    0x42: (149, "DRAGONITE"),
    0x46: (84, "DODUO"),
    0x47: (60, "POLIWAG"),
    0x48: (124, "JYNX"),
    0x49: (146, "MOLTRES"),
    0x4A: (144, "ARTICUNO"),
    0x4B: (145, "ZAPDOS"),
    0x4C: (132, "DITTO"),
    0x4D: (52, "MEOWTH"),
    0x4E: (98, "KRABBY"),
    0x52: (37, "VULPIX"),
    0x53: (38, "NINETALES"),
    0x54: (25, "PIKACHU"),
    0x55: (26, "RAICHU"),
    0x58: (147, "DRATINI"),
    0x59: (148, "DRAGONAIR"),
    0x5A: (140, "KABUTO"),
    0x5B: (141, "KABUTOPS"),
    0x5C: (116, "HORSEA"),
    0x5D: (117, "SEADRA"),
    0x60: (27, "SANDSHREW"),
    0x61: (28, "SANDSLASH"),
    0x62: (138, "OMANYTE"),
    0x63: (139, "OMASTAR"),
    0x64: (39, "JIGGLYPUFF"),
    0x65: (40, "WIGGLYTUFF"),
    0x66: (133, "EEVEE"),
    0x67: (136, "FLAREON"),
    0x68: (135, "JOLTEON"),
    0x69: (134, "VAPOREON"),
    0x6A: (66, "MACHOP"),
    0x6B: (41, "ZUBAT"),
    0x6C: (23, "EKANS"),
    0x6D: (46, "PARAS"),
    0x6E: (61, "POLIWHIRL"),
    0x6F: (62, "POLIWRATH"),
    0x70: (13, "WEEDLE"),
    0x71: (14, "KAKUNA"),
    0x72: (15, "BEEDRILL"),
    0x74: (85, "DODRIO"),
    0x75: (57, "PRIMEAPE"),
    0x76: (51, "DUGTRIO"),
    0x77: (49, "VENOMOTH"),
    0x78: (87, "DEWGONG"),
    0x7B: (10, "CATERPIE"),
    0x7C: (11, "METAPOD"),
    0x7D: (12, "BUTTERFREE"),
    0x7E: (68, "MACHAMP"),
    0x80: (55, "GOLDUCK"),
    0x81: (97, "HYPNO"),
    0x82: (42, "GOLBAT"),
    0x83: (150, "MEWTWO"),
    0x84: (143, "SNORLAX"),
    0x85: (129, "MAGIKARP"),
    0x88: (89, "MUK"),
    0x8A: (99, "KINGLER"),
    0x8B: (91, "CLOYSTER"),
    0x8D: (101, "ELECTRODE"),
    0x8E: (36, "CLEFABLE"),
    0x8F: (110, "WEEZING"),
    0x90: (53, "PERSIAN"),
    0x91: (105, "MAROWAK"),
    0x93: (93, "HAUNTER"),
    0x94: (63, "ABRA"),
    0x95: (65, "ALAKAZAM"),
    0x96: (17, "PIDGEOTTO"),
    0x97: (18, "PIDGEOT"),
    0x98: (121, "STARMIE"),
    0x99: (1, "BULBASAUR"),
    0x9A: (3, "VENUSAUR"),
    0x9B: (73, "TENTACRUEL"),
    0x9D: (118, "GOLDEEN"),
    0x9E: (119, "SEAKING"),
    0xA3: (77, "PONYTA"),
    0xA4: (78, "RAPIDASH"),
    0xA5: (19, "RATTATA"),
    0xA6: (20, "RATICATE"),
    0xA7: (33, "NIDORINO"),
    0xA8: (30, "NIDORINA"),
    0xA9: (74, "GEODUDE"),
    0xAA: (137, "PORYGON"),
    0xAB: (142, "AERODACTYL"),
    0xAD: (81, "MAGNEMITE"),
    0xB0: (4, "CHARMANDER"),
    0xB1: (7, "SQUIRTLE"),
    0xB2: (5, "CHARMELEON"),
    0xB3: (8, "WARTORTLE"),
    0xB4: (6, "CHARIZARD"),
    0xB9: (43, "ODDISH"),
    0xBA: (44, "GLOOM"),
    0xBB: (45, "VILEPLUME"),
    0xBC: (69, "BELLSPROUT"),
    0xBD: (70, "WEEPINBELL"),
    0xBE: (71, "VICTREEBEL"),
}


SPECIAL_CHARACTERS = {
    0x9A: "(",
    0x9B: ")",
    0x9C: ":",
    0x9D: ";",
    0x9E: "[",
    0x9F: "]",
    0xBA: "é",
    0xBB: "'d",
    0xBC: "'l",
    0xBD: "'s",
    0xBE: "'t",
    0xBF: "'v",
    0xE0: "'",
    0xE3: "-",
    0xE4: "'r",
    0xE5: "'m",
    0xE6: "?",
    0xE7: "!",
    0xE8: ".",
    0xEF: "♂",
    0xF2: ".",
    0xF3: "/",
    0xF4: ",",
    0xF5: "♀",
}


def read_party(memory: MemoryView) -> dict[str, Any]:
    count = _byte(memory, PARTY_COUNT_ADDRESS)
    if count < 0 or count > PARTY_LENGTH:
        raise PartyDataError("party count is invalid")
    if count == 0:
        return {"available": True, "party": []}

    species_list = _bytes(memory, PARTY_SPECIES_ADDRESS, PARTY_LENGTH + 1)
    if species_list[count] != 0xFF:
        raise PartyDataError("party species terminator is missing")

    party: list[dict[str, Any]] = []
    for index in range(count):
        species_id = species_list[index]
        species = SPECIES_BY_INTERNAL_ID.get(species_id)
        if species is None:
            raise PartyDataError("party species is invalid")

        address = PARTY_STRUCT_ADDRESS + index * PARTY_STRUCT_LENGTH
        if _byte(memory, address) != species_id:
            raise PartyDataError("party species fields do not match")

        hp = _u16(memory, address + MON_HP_OFFSET)
        max_hp = _u16(memory, address + MON_MAX_HP_OFFSET)
        level = _byte(memory, address + MON_LEVEL_OFFSET)
        raw_status = _byte(memory, address + MON_STATUS_OFFSET)
        _validate_stats(hp, max_hp, level)

        nickname_address = PARTY_NICKNAMES_ADDRESS + index * NAME_LENGTH
        nickname = decode_name(_bytes(memory, nickname_address, NAME_LENGTH))
        pokedex_number, species_name = species
        if not nickname:
            nickname = species_name

        party.append(
            {
                "slot": index + 1,
                "nickname": nickname,
                "species": species_name,
                "pokedexNumber": pokedex_number,
                "level": level,
                "hp": hp,
                "maxHp": max_hp,
                "status": decode_status(raw_status, hp),
                "active": False,
                "fainted": hp == 0,
            }
        )

    _apply_battle_overlay(memory, party, species_list)
    return {"available": True, "party": party}


def unavailable_party() -> dict[str, Any]:
    return {"available": False, "party": []}


def decode_name(values: list[int]) -> str:
    result: list[str] = []
    for value in values:
        if value == 0x50:
            break
        if 0x80 <= value <= 0x99:
            result.append(chr(ord("A") + value - 0x80))
        elif 0xA0 <= value <= 0xB9:
            result.append(chr(ord("a") + value - 0xA0))
        elif 0xF6 <= value <= 0xFF:
            result.append(str(value - 0xF6))
        else:
            result.append(SPECIAL_CHARACTERS.get(value, ""))
    return "".join(result).strip()


def decode_status(value: int, hp: int) -> str:
    if hp == 0:
        return "FNT"
    if value & 0x07:
        return "SLP"
    if value & (1 << 3):
        return "PSN"
    if value & (1 << 4):
        return "BRN"
    if value & (1 << 5):
        return "FRZ"
    if value & (1 << 6):
        return "PAR"
    return "OK"


def _apply_battle_overlay(
    memory: MemoryView,
    party: list[dict[str, Any]],
    species_list: list[int],
) -> None:
    if _byte(memory, BATTLE_STATE_ADDRESS) not in (1, 2):
        return
    active_index = _byte(memory, PLAYER_MON_NUMBER_ADDRESS)
    if active_index >= len(party):
        return
    if _byte(memory, BATTLE_MON_ADDRESS) != species_list[active_index]:
        return

    hp = _u16(memory, BATTLE_MON_ADDRESS + BATTLE_MON_HP_OFFSET)
    max_hp = _u16(memory, BATTLE_MON_ADDRESS + BATTLE_MON_MAX_HP_OFFSET)
    level = _byte(memory, BATTLE_MON_ADDRESS + BATTLE_MON_LEVEL_OFFSET)
    raw_status = _byte(memory, BATTLE_MON_ADDRESS + BATTLE_MON_STATUS_OFFSET)
    _validate_stats(hp, max_hp, level)

    member = party[active_index]
    member.update(
        {
            "hp": hp,
            "maxHp": max_hp,
            "level": level,
            "status": decode_status(raw_status, hp),
            "active": True,
            "fainted": hp == 0,
        }
    )


def _validate_stats(hp: int, max_hp: int, level: int) -> None:
    if max_hp < 1 or max_hp > 999 or hp < 0 or hp > max_hp:
        raise PartyDataError("party HP is invalid")
    if level < 1 or level > 100:
        raise PartyDataError("party level is invalid")


def _byte(memory: MemoryView, address: int) -> int:
    value = memory[address]
    if not isinstance(value, int) or value < 0 or value > 0xFF:
        raise PartyDataError("memory byte is invalid")
    return value


def _bytes(memory: MemoryView, address: int, length: int) -> list[int]:
    values = memory[address : address + length]
    if not isinstance(values, list) or len(values) != length:
        raise PartyDataError("memory range is invalid")
    if any(not isinstance(value, int) or value < 0 or value > 0xFF for value in values):
        raise PartyDataError("memory range contains an invalid byte")
    return values


def _u16(memory: MemoryView, address: int) -> int:
    return (_byte(memory, address) << 8) | _byte(memory, address + 1)
