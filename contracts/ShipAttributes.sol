// SPDX-License-Identifier: UNLICENSED

// Attributes turns traits into the numbers used by the game
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Types.sol";
import "./IShips.sol";
import "./IShipAttributes.sol";

contract ShipAttributes is IShipAttributes, Ownable {
    IShips public ships;

    // Attributes are per-variant and versioned exactly like costs: each
    // variant has its own counter, and setVariantAttributes publishes a
    // complete new version (latest + 1) and makes it live in one call.
    // Published versions are IMMUTABLE — that is what lets a game pin the
    // version its ships were calculated under (Attributes.version, stored
    // per ship by Game.calculateShipAttributes) and keep reading that exact
    // table (getSpecialRangeAt/getSpecialStrengthAt) for its whole lifetime,
    // no matter what is published or rolled back afterwards.
    mapping(uint16 variant => mapping(uint16 version => VariantAttributeData))
        internal _attributesByVariant;
    // Live pointer: which published version new calculations use. 0 means
    // the variant has never been configured.
    mapping(uint16 variant => uint16) internal _currentAttributesVersion;
    // Highest version ever published for the variant.
    mapping(uint16 variant => uint16) internal _latestAttributesVersion;

    // Cost system — per-variant, keyed by traits.variant. A zero-valued
    // `.version` means the variant has never been configured; reads for an
    // unconfigured variant revert (fail loud) rather than silently
    // returning a near-zero cost — same philosophy as VariantAttributeData.
    mapping(uint16 => Costs) public costsByVariant;

    // Required array lengths, enforced at publish time so a malformed table
    // can never go live and make every ship of a variant revert on lookup.
    // Equipment arrays are indexed by their enum value, and GenerateNewShip
    // only rolls a subset of them but customizeShip/DroneYard/prize ships can
    // equip any enum value — so every slot must exist. Trait-tier arrays are
    // indexed by traits.accuracy/hull/speed, which are plain uint8 tiers 0-2.
    uint internal constant TIER_COUNT = 3;
    uint internal constant GUN_SLOTS = uint(type(MainWeapon).max) + 1;
    uint internal constant ARMOR_SLOTS = uint(type(Armor).max) + 1;
    uint internal constant SHIELD_SLOTS = uint(type(Shields).max) + 1;
    uint internal constant SPECIAL_SLOTS = uint(type(Special).max) + 1;
    // Ranks 1..RANK_COUNT; RANK_COUNT - 1 thresholds separate them.
    uint internal constant RANK_COUNT = 6;
    // Bonus is applied with checked uint8 math in calculateShipAttributes, so
    // a huge bonus would just make that ship's calculation revert; 100% is
    // the ceiling on what an owner can publish.
    uint8 internal constant MAX_RANK_BONUS_PCT = 100;
    // Floors on a ship's FINAL range and movement. A ship must always be able
    // to move at least one tile and shoot at least an adjacent target: a
    // table whose gear penalties sum to <= 0 movement (or an inert gun with
    // range 0) would otherwise leave a ship that can never move, or can
    // never shoot. Applied to the computed totals in calculateShipAttributes,
    // after every bonus, so individual table entries (including negative
    // movement modifiers and inert range-0 filler guns) stay expressible.
    uint8 internal constant MIN_RANGE = 1;
    uint8 internal constant MIN_MOVEMENT = 1;

    error InvalidAttributesVersion();
    error ShipNotFound();
    error InvalidCostsVersion();
    error VariantNotConfigured(uint16 variant);
    error InvalidArrayLength();
    error InvalidRankConfig();

    event CostsSet(uint16 variant, uint16 version);
    event CurrentAttributesVersionSet(uint16 variant, uint16 version);
    event VariantAttributesPublished(uint16 variant, uint16 version);

    // No variant is seeded here on purpose — variant 1 and variant 2 are
    // both configured identically via setCosts/setVariantAttributes calls
    // in ignition/modules/DeployAndConfig.ts (setCostsVariant1Call/
    // setVariant1AttributesCall alongside their variant-2 counterparts),
    // not hardcoded here. Every variant, including 1, is unconfigured
    // (fails loud — see VariantNotConfigured) until those calls run.
    constructor(address _ships) Ownable(msg.sender) {
        ships = IShips(_ships);
    }

    function setShipsAddress(address _ships) public onlyOwner {
        ships = IShips(_ships);
    }

    // Calculate attributes for a ship in memory and return Attributes
    function calculateShipAttributes(
        Ship memory _ship
    ) public view returns (Attributes memory) {
        return
            _calculate(
                ShipStatsInput(
                    _ship.id,
                    _ship.equipment,
                    _ship.traits.variant,
                    _ship.traits.accuracy,
                    _ship.traits.hull,
                    _ship.traits.speed,
                    _ship.shipData.shipsDestroyed
                )
            );
    }

    // The stats calculation, from just the fields it uses (ShipStatsInput).
    function _calculate(
        ShipStatsInput memory _ship
    ) internal view returns (Attributes memory) {
        if (_ship.id == 0) revert ShipNotFound();

        VariantAttributeData storage variantData = _currentData(
            _ship.variant
        );
        // rank = 1 + number of thresholds the ship's kills have reached;
        // the bonus table is indexed by rank - 1.
        uint8 rankMultiplier = variantData.rankBonusPct[
            _rankOf(variantData, _ship.shipsDestroyed) - 1
        ];

        Attributes memory attributes;
        // Calculate base attributes from ship traits and equipment
        attributes.version = _currentAttributesVersion[_ship.variant];
        attributes.range = variantData
            .guns[uint8(_ship.equipment.mainWeapon)]
            .range;
        // Increase range by the rank multiplier as a percentage (avoid overflow)
        uint calculatedBonus = (uint(attributes.range) * rankMultiplier) / 100;
        attributes.range += uint8(calculatedBonus);

        // Apply fore accuracy bonus to range as percentage increase (bridge + level extend range)
        uint8 foreAccuracyBonus = variantData.foreAccuracy[
            uint8(_ship.accuracy)
        ];
        calculatedBonus = (uint(attributes.range) * foreAccuracyBonus) / 100;
        attributes.range += uint8(calculatedBonus);
        if (attributes.range < MIN_RANGE) attributes.range = MIN_RANGE;
        attributes.gunDamage = variantData
            .guns[uint8(_ship.equipment.mainWeapon)]
            .damage;
        // Increase damage by the rank multiplier as a percentage (avoid overflow)
        calculatedBonus = (uint(attributes.gunDamage) * rankMultiplier) / 100;
        attributes.gunDamage += uint8(calculatedBonus);
        attributes.hullPoints = _calculateHullPoints(variantData, _ship);
        // Increase hull points by the rank multiplier as a percentage (avoid overflow)
        calculatedBonus = (uint(attributes.hullPoints) * rankMultiplier) / 100;
        attributes.hullPoints += uint8(calculatedBonus);
        attributes.maxHullPoints = attributes.hullPoints;
        attributes.movement = _calculateMovement(variantData, _ship);
        // Increase movement by the rank multiplier as a percentage (avoid overflow)
        calculatedBonus = (uint(attributes.movement) * rankMultiplier) / 100;
        attributes.movement += uint8(calculatedBonus);
        if (attributes.movement < MIN_MOVEMENT) {
            attributes.movement = MIN_MOVEMENT;
        }
        attributes.damageReduction = _calculateDamageReduction(variantData, _ship);
        // Increase damage reduction by the rank multiplier as a percentage (avoid overflow)
        calculatedBonus =
            (uint(attributes.damageReduction) * rankMultiplier) /
            100;
        attributes.damageReduction += uint8(calculatedBonus);
        // Cap at 100% (HA3-02): every damage-reduction consumer computes
        // `baseDamage - (baseDamage * reduction) / 100`, which underflows
        // and reverts once reduction exceeds 100 instead of flooring at 0
        // damage — an uncapped value here (reachable via armor+shield
        // configuration alone, before the rank bonus above can push it
        // higher still) would make a ship permanently unshootable rather
        // than just very resistant.
        if (attributes.damageReduction > 100) {
            attributes.damageReduction = 100;
        }
        return attributes;
    }

    /// @notice Rank (1..6) a ship with `_shipsDestroyed` kills holds under
    /// the variant's CURRENT attribute version.
    function getRank(
        uint16 _variant,
        uint _shipsDestroyed
    ) external view returns (uint8) {
        return _rankOf(_currentData(_variant), _shipsDestroyed);
    }

    // Calculate attributes for a ship by ID
    function calculateShipAttributesById(
        uint _shipId
    ) public view returns (Attributes memory) {
        return _calculate(ships.getShipStatsInput(_shipId));
    }

    // For Game.startGame (2026-10-31): each ship's stats plus the two fields
    // Game keeps on its board for the rest of the match, for a whole fleet
    // in one call, read through the slim ShipStatsInput (Game never decodes
    // a full Ship).
    function calculateBoardStatsByIds(
        uint[] calldata _shipIds
    )
        external
        view
        returns (
            Attributes[] memory attributes,
            uint16[] memory variants,
            Special[] memory specials
        )
    {
        attributes = new Attributes[](_shipIds.length);
        variants = new uint16[](_shipIds.length);
        specials = new Special[](_shipIds.length);
        for (uint i = 0; i < _shipIds.length; i++) {
            ShipStatsInput memory input = ships.getShipStatsInput(_shipIds[i]);
            attributes[i] = _calculate(input);
            variants[i] = input.variant;
            specials[i] = input.equipment.special;
        }
    }

    // Calculate attributes for multiple ships by their IDs
    function calculateShipAttributesByIds(
        uint[] memory _shipIds
    ) public view returns (Attributes[] memory) {
        Attributes[] memory results = new Attributes[](_shipIds.length);

        for (uint i = 0; i < _shipIds.length; i++) {
            results[i] = _calculate(ships.getShipStatsInput(_shipIds[i]));
        }

        return results;
    }

    // Internal calculation functions

    // Storage table for the variant's live version. Reverts with a named
    // error (rather than an array-out-of-bounds panic) if never configured.
    function _currentData(
        uint16 _variant
    ) internal view returns (VariantAttributeData storage) {
        uint16 version = _currentAttributesVersion[_variant];
        if (version == 0) revert VariantNotConfigured(_variant);
        return _attributesByVariant[_variant][version];
    }

    // Storage table for a specific published version of a variant.
    function _dataAt(
        uint16 _variant,
        uint16 _version
    ) internal view returns (VariantAttributeData storage) {
        if (_version == 0 || _version > _latestAttributesVersion[_variant]) {
            revert InvalidAttributesVersion();
        }
        return _attributesByVariant[_variant][_version];
    }

    // rank = 1 + number of thresholds reached. Thresholds are strictly
    // ascending (enforced at publish), so the loop can stop at the first
    // one not reached.
    function _rankOf(
        VariantAttributeData storage variantData,
        uint _shipsDestroyed
    ) internal view returns (uint8 rank) {
        uint32[] storage thresholds = variantData.rankThresholds;
        rank = 1;
        for (uint i = 0; i < thresholds.length; i++) {
            if (_shipsDestroyed < thresholds[i]) break;
            rank++;
        }
    }

    function _calculateHullPoints(
        VariantAttributeData storage variantData,
        ShipStatsInput memory _ship
    ) internal view returns (uint8) {
        uint8 baseHull = variantData.baseHull;
        // uint8 traitBonus = _ship.hull * 10; // Convert trait to hull points
        uint8 traitBonus = variantData.hull[_ship.hull];
        return baseHull + traitBonus;
    }

    function _calculateMovement(
        VariantAttributeData storage variantData,
        ShipStatsInput memory _ship
    ) internal view returns (uint8) {
        int8 baseMovement = int8(variantData.baseSpeed);

        // Add trait bonus
        baseMovement += int8(variantData.engineSpeeds[_ship.speed]);

        // Extract equipment bonuses as int8 to avoid stack-too-deep or type mismatch
        int8 gunMovement = variantData
            .guns[uint8(_ship.equipment.mainWeapon)]
            .movement;
        // Defensive gear's movement: a piece only counts when it is actually
        // equipped. The tables' "None" entries (index 0) are the bonus for
        // carrying no defensive gear, and it must be counted ONCE — a ship
        // carries armor OR shields, so one of the two slots is always None, and
        // summing both tables' None entries would hand every ship a free bonus
        // (and a bare ship a doubled one). Only when the ship carries neither
        // does the None bonus apply, taken from the armor table (the shields
        // table's None movement is never read).
        int8 armorMovement;
        int8 shieldMovement;
        if (_ship.equipment.armor != Armor.None) {
            armorMovement = variantData
                .armors[uint8(_ship.equipment.armor)]
                .movement;
        }
        if (_ship.equipment.shields != Shields.None) {
            shieldMovement = variantData
                .shields[uint8(_ship.equipment.shields)]
                .movement;
        }
        if (
            _ship.equipment.armor == Armor.None &&
            _ship.equipment.shields == Shields.None
        ) {
            armorMovement = variantData.armors[0].movement;
        }
        int8 specialMovement = variantData
            .specials[uint8(_ship.equipment.special)]
            .movement;

        baseMovement +=
            gunMovement +
            armorMovement +
            shieldMovement +
            specialMovement;

        return baseMovement > 0 ? uint8(baseMovement) : 0;
    }

    function _calculateDamageReduction(
        VariantAttributeData storage variantData,
        ShipStatsInput memory _ship
    ) internal view returns (uint8) {
        uint8 damageReduction = 0;

        damageReduction += variantData
            .armors[uint8(_ship.equipment.armor)]
            .damageReduction;
        damageReduction += variantData
            .shields[uint8(_ship.equipment.shields)]
            .damageReduction;

        return damageReduction;
    }

    // The getters below read the variant's LIVE (current) version — for
    // display and tooling. In-game logic must NOT use them: a game pins the
    // attributes version of its ships (Attributes.version) and reads specials
    // through getSpecialRangeAt/getSpecialStrengthAt so a later publish or
    // rollback can't change an in-flight game.

    // Get special range from the current attributes version
    function getSpecialRange(
        Special _special,
        uint16 _variant
    ) public view returns (uint8) {
        return _currentData(_variant).specials[uint8(_special)].range;
    }

    // Get special strength from the current attributes version
    function getSpecialStrength(
        Special _special,
        uint16 _variant
    ) public view returns (uint8) {
        return _currentData(_variant).specials[uint8(_special)].strength;
    }

    // Get special range from a specific published version (the one a game
    // pinned in its ship's Attributes.version).
    function getSpecialRangeAt(
        uint16 _variant,
        uint16 _version,
        Special _special
    ) external view returns (uint8) {
        return _dataAt(_variant, _version).specials[uint8(_special)].range;
    }

    // Get special strength from a specific published version.
    function getSpecialStrengthAt(
        uint16 _variant,
        uint16 _version,
        Special _special
    ) external view returns (uint8) {
        return _dataAt(_variant, _version).specials[uint8(_special)].strength;
    }

    // Get gun data for a variant from the current attributes version
    function getGunData(
        MainWeapon _weapon,
        uint16 _variant
    ) public view returns (GunData memory) {
        return _currentData(_variant).guns[uint8(_weapon)];
    }

    // Get armor data for a variant from the current attributes version
    function getArmorData(
        Armor _armor,
        uint16 _variant
    ) public view returns (ArmorData memory) {
        return _currentData(_variant).armors[uint8(_armor)];
    }

    // Get shield data for a variant from the current attributes version
    function getShieldData(
        Shields _shields,
        uint16 _variant
    ) public view returns (ShieldData memory) {
        return _currentData(_variant).shields[uint8(_shields)];
    }

    // Get special data from the current attributes version
    function getSpecialData(
        Special _special,
        uint16 _variant
    ) public view returns (SpecialData memory) {
        return _currentData(_variant).specials[uint8(_special)];
    }

    // Cost calculation functions
    function calculateShipCost(
        Ship memory ship
    ) external view returns (uint16) {
        Costs storage costs = costsByVariant[ship.traits.variant];
        if (costs.version == 0) revert InvalidCostsVersion();

        // Widened to uint16 up front: summing the uint8 table entries in
        // uint8 arithmetic would revert for any ship totalling more than 255.
        uint16 unadjustedCost = uint16(costs.baseCost) +
            costs.accuracy[uint8(ship.traits.accuracy)] +
            costs.hull[uint8(ship.traits.hull)] +
            costs.speed[uint8(ship.traits.speed)] +
            costs.mainWeapon[uint8(ship.equipment.mainWeapon)] +
            costs.armor[uint8(ship.equipment.armor)] +
            costs.shields[uint8(ship.equipment.shields)] +
            costs.special[uint8(ship.equipment.special)];

        // TODO: Add rank-based discounts here if needed
        // For now, return unadjusted cost
        return unadjustedCost;
    }

    function setCosts(
        uint16 _variant,
        Costs memory _costs
    ) external onlyOwner {
        if (
            _costs.accuracy.length != TIER_COUNT ||
            _costs.hull.length != TIER_COUNT ||
            _costs.speed.length != TIER_COUNT ||
            _costs.mainWeapon.length != GUN_SLOTS ||
            _costs.armor.length != ARMOR_SLOTS ||
            _costs.shields.length != SHIELD_SLOTS ||
            _costs.special.length != SPECIAL_SLOTS
        ) revert InvalidArrayLength();

        // Compute the new version from current storage before it's overwritten below,
        // and ignore whatever `_costs.version` the caller passed in — otherwise a
        // stale/zero/duplicate caller-supplied version would silently corrupt the
        // costsVersion ships rely on to detect stale cost data (see H-01/M-01).
        uint16 newVersion = costsByVariant[_variant].version + 1;
        costsByVariant[_variant] = _costs;
        costsByVariant[_variant].version = newVersion;
        emit CostsSet(_variant, newVersion);
    }

    function getCosts(
        uint16 _variant
    ) external view returns (uint, Costs memory) {
        return (costsByVariant[_variant].version, costsByVariant[_variant]);
    }

    function getCurrentCostsVersion(
        uint16 _variant
    ) external view returns (uint16) {
        return costsByVariant[_variant].version;
    }

    // Attributes version management functions

    /// @notice Live attributes version for a variant (0 = never configured).
    function getCurrentAttributesVersion(
        uint16 _variant
    ) external view returns (uint16) {
        return _currentAttributesVersion[_variant];
    }

    /// @notice Highest attributes version ever published for a variant.
    function getLatestAttributesVersion(
        uint16 _variant
    ) external view returns (uint16) {
        return _latestAttributesVersion[_variant];
    }

    /**
     * @dev Point a variant's live attributes at any version already
     * published for it — the rollback / roll-forward lever. Games already
     * underway are unaffected (they pin their own version); this only
     * changes what NEW calculations use.
     */
    function setCurrentAttributesVersion(
        uint16 _variant,
        uint16 _version
    ) external onlyOwner {
        if (_version == 0 || _version > _latestAttributesVersion[_variant]) {
            revert InvalidAttributesVersion();
        }
        _currentAttributesVersion[_variant] = _version;
        emit CurrentAttributesVersionSet(_variant, _version);
    }

    /**
     * @notice Full published table for a variant at `_version` (0 = the
     * variant's current version). Includes every array — foreAccuracy, hull,
     * engineSpeeds, rank rules — that the per-item getters don't expose, so
     * tooling can read, diff, or copy a variant.
     */
    function getVariantAttributes(
        uint16 _variant,
        uint16 _version
    ) external view returns (VariantAttributeData memory) {
        uint16 version = _version == 0
            ? _currentAttributesVersion[_variant]
            : _version;
        if (version == 0) revert VariantNotConfigured(_variant);
        return _dataAt(_variant, version);
    }

    /**
     * @dev Publish a complete new attributes version for one variant
     * (faction) and make it live, in one call: base hull/speed, per-tier
     * bonuses, weapon/armor/shield stats, equipped-Special data, and rank
     * rules. The version is always the variant's latest + 1 — callers don't
     * choose it (same as setCosts). Published versions are never modified;
     * to change anything, publish again. Other variants are untouched, and
     * there is no half-configured state: the new version only becomes
     * current once every array has been written and validated.
     *
     * A variant must be published before any ship with that traits.variant
     * can have its attributes or cost calculated — lookups for an
     * unconfigured variant revert VariantNotConfigured (fail loud) rather
     * than silently falling back to a default. Publish ShipAttributes for a
     * variant BEFORE raising Ships.maxVariant to admit it.
     * @param params See SetVariantAttributesParams.
     */
    function setVariantAttributes(
        SetVariantAttributesParams memory params
    ) external onlyOwner {
        _validateAttributes(params);

        uint16 newVersion = _latestAttributesVersion[params.variant] + 1;

        // Freshly-published slot, so every array starts empty — no delete
        // needed before pushing.
        VariantAttributeData storage variantData = _attributesByVariant[
            params.variant
        ][newVersion];

        variantData.baseHull = params.baseHull;
        variantData.baseSpeed = params.baseSpeed;

        for (uint i = 0; i < params.foreAccuracy.length; i++) {
            variantData.foreAccuracy.push(params.foreAccuracy[i]);
        }
        for (uint i = 0; i < params.hull.length; i++) {
            variantData.hull.push(params.hull[i]);
        }
        for (uint i = 0; i < params.engineSpeeds.length; i++) {
            variantData.engineSpeeds.push(params.engineSpeeds[i]);
        }
        for (uint i = 0; i < params.guns.length; i++) {
            variantData.guns.push(params.guns[i]);
        }
        for (uint i = 0; i < params.armors.length; i++) {
            variantData.armors.push(params.armors[i]);
        }
        for (uint i = 0; i < params.shields.length; i++) {
            variantData.shields.push(params.shields[i]);
        }
        for (uint i = 0; i < params.specials.length; i++) {
            variantData.specials.push(params.specials[i]);
        }
        for (uint i = 0; i < params.rankThresholds.length; i++) {
            variantData.rankThresholds.push(params.rankThresholds[i]);
        }
        for (uint i = 0; i < params.rankBonusPct.length; i++) {
            variantData.rankBonusPct.push(params.rankBonusPct[i]);
        }

        _latestAttributesVersion[params.variant] = newVersion;
        _currentAttributesVersion[params.variant] = newVersion;
        emit VariantAttributesPublished(params.variant, newVersion);
    }

    // Reject a malformed table before it can go live (M-04): wrong-length
    // arrays would panic out-of-bounds on lookup for every ship of the
    // variant, and mis-ordered rank thresholds would make ranks meaningless.
    function _validateAttributes(
        SetVariantAttributesParams memory params
    ) internal pure {
        if (
            params.foreAccuracy.length != TIER_COUNT ||
            params.hull.length != TIER_COUNT ||
            params.engineSpeeds.length != TIER_COUNT ||
            params.guns.length != GUN_SLOTS ||
            params.armors.length != ARMOR_SLOTS ||
            params.shields.length != SHIELD_SLOTS ||
            params.specials.length != SPECIAL_SLOTS ||
            params.rankThresholds.length != RANK_COUNT - 1 ||
            params.rankBonusPct.length != RANK_COUNT
        ) revert InvalidArrayLength();

        // Strictly ascending and > 0, so rank 1 is always reachable at 0 kills
        // and every rank has a distinct kill requirement.
        if (params.rankThresholds[0] == 0) revert InvalidRankConfig();
        for (uint i = 1; i < params.rankThresholds.length; i++) {
            if (params.rankThresholds[i] <= params.rankThresholds[i - 1]) {
                revert InvalidRankConfig();
            }
        }
        for (uint i = 0; i < params.rankBonusPct.length; i++) {
            if (params.rankBonusPct[i] > MAX_RANK_BONUS_PCT) {
                revert InvalidRankConfig();
            }
        }
    }
}
