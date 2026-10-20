// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

function hexToUint24(string memory hexColor) pure returns (uint24) {
    bytes memory b = bytes(hexColor);
    require(b.length == 7 && b[0] == "#", "Invalid hex color format");

    uint24 result = 0;
    for (uint i = 1; i < 7; i++) {
        uint8 digit = uint8(b[i]);
        if (digit >= 48 && digit <= 57) {
            // 0-9
            result = (result << 4) | (digit - 48);
        } else if (digit >= 97 && digit <= 102) {
            // a-f
            result = (result << 4) | (digit - 87);
        } else if (digit >= 65 && digit <= 70) {
            // A-F
            result = (result << 4) | (digit - 55);
        } else {
            revert("Invalid hex character");
        }
    }
    return result;
}

function blendColors(
    uint8 r1,
    uint8 g1,
    uint8 b1,
    string memory hexColor
) pure returns (string memory) {
    // Modify the hex color with the rgb values using a 75% blend
    uint24 color = hexToUint24(hexColor);
    uint8 r2 = uint8(color >> 16);
    uint8 g2 = uint8((color >> 8) & 0xFF);
    uint8 b2 = uint8(color & 0xFF);

    uint8 r = (r1 * 25 + r2 * 75) / 100;
    uint8 g = (g1 * 25 + g2 * 75) / 100;
    uint8 b = (b1 * 25 + b2 * 75) / 100;

    return
        string(
            abi.encodePacked(
                "#",
                toHexString(r),
                toHexString(g),
                toHexString(b)
            )
        );
}

function toHexString(uint8 value) pure returns (string memory) {
    bytes memory buffer = new bytes(2);
    buffer[0] = bytes1(uint8((value >> 4) + (value >> 4 < 10 ? 48 : 87)));
    buffer[1] = bytes1(uint8((value & 0x0F) + ((value & 0x0F) < 10 ? 48 : 87)));
    return string(buffer);
}

// Parses an "hsl(200, 40%, 47%)"-format string into its three numbers.
// Factored out of blendHSL so blendHSLV2 (see below) can reuse the same
// parsing without duplicating it.
function parseHSL(
    string memory hslString
) pure returns (uint h2, uint s2, uint l2) {
    bytes memory b = bytes(hslString);
    require(b.length >= 10, "Invalid HSL string format");

    uint start = 4; // Skip "hsl("
    uint end = start;
    while (end < b.length && b[end] != ",") end++;
    h2 = parseUint(b, start, end);

    start = end + 1;
    while (start < b.length && (b[start] == " " || b[start] == ",")) start++;
    end = start;
    while (end < b.length && b[end] != "%") end++;
    s2 = parseUint(b, start, end);

    start = end + 1;
    while (start < b.length && (b[start] == " " || b[start] == ",")) start++;
    end = start;
    while (end < b.length && b[end] != "%") end++;
    l2 = parseUint(b, start, end);
}

// Shared by blendHSL and blendHSLV2 so neither pulls the other's bytecode
// into a contract that only calls one of them -- Solidity inlines each
// free function's own body into every contract that reaches it in its call
// graph, so blendHSLV2 calling blendHSL as a fallback (an earlier version
// of this file did exactly that) meant every variant-2 leaf paid for BOTH
// functions' full string-building logic, ~4.5KB extra per contract,
// pushing several leaves back over budget. Splitting the "build the
// output string" and "compute a 50/50-ish blend" pieces out here means
// each of blendHSL/blendHSLV2 only pulls in the specific math it needs.
function hslString(uint h, uint s, uint l) pure returns (string memory) {
    return
        string(
            abi.encodePacked(
                "hsl(",
                uintToString(h),
                ", ",
                uintToString(s),
                "%, ",
                uintToString(l),
                "%)"
            )
        );
}

function blendValues(
    uint h,
    uint s,
    uint l,
    uint h2,
    uint s2,
    uint l2
) pure returns (uint blendedH, uint blendedS, uint blendedL) {
    // H: 50/50 blend, but don't change hue too much if saturation is > 40
    if (s2 > 40) {
        blendedH = (h2 * 95 + h * 5) / 100;
    } else {
        blendedH = (h2 * 50 + h * 50) / 100;
    }

    // S: Blend the two values with different ratios based on base saturation
    if (s2 > 40) {
        blendedS = (s2 * 95 + s * 5) / 100;
    } else {
        blendedS = (s2 * 35 + s * 65) / 100;
    }

    // L: 85% old, 15% new
    blendedL = (l2 * 85 + l * 15) / 100;
}

// Variant 1's shiny tint. Muted art colors (saturation <= 40: the whole
// grey/blue hull and structure) take the ship's own hue and saturation and
// keep their lightness, so shading survives. Changed 2026-10-20: these used
// to go through blendValues' 50/50 hue average, and since every one of them
// sits at hue ~213-225 the result was stuck between ~106 (green) and ~292
// (purple) -- red, orange and gold shinies were impossible, and hue 0 vs
// 359 (both red) came out green vs purple. Vivid accents (shield/engine
// glows, saturation > 40) keep blendValues' gentle tint, same as before --
// written out here rather than calling blendValues, since only its
// saturation > 40 branch is reachable now, and the unused branch's bytecode
// pushed RenderArmor3 over the 24 KiB limit.
// Changed again 2026-10-20: the muted colors kept the art's lightness and
// ignored the ship's, so changing l barely did anything. Now they move
// halfway toward white (l > 50) or black (l < 50), in proportion to how far
// l is from 50, which keeps the panel shading at both ends. l 50-99 is
// squeezed into 50-85 first, since the brightest ships otherwise washed
// out to flat pastel.
function blendHSL(
    uint h,
    uint s,
    uint l,
    string memory hslStringIn
) pure returns (string memory) {
    (uint h2, uint s2, uint l2) = parseHSL(hslStringIn);
    if (s2 <= 40) {
        if (l > 50) {
            l = 50 + ((l - 50) * 35) / 49;
            return hslString(h, s, l2 + ((100 - l2) * (l - 50)) / 100);
        }
        return hslString(h, s, l2 - (l2 * (50 - l)) / 100);
    }
    return
        hslString(
            (h2 * 95 + h * 5) / 100,
            (s2 * 95 + s * 5) / 100,
            (l2 * 85 + l * 15) / 100
        );
}

// True for colors in variant 2's dense orange/amber accent-highlight range
// (weapon glows, engine lights, etc.) -- calibrated against the actual
// generated palette in contracts/RenderersV2/*.sol: vivid accents cluster
// at hue 10-36 with saturation 89-100%, while structural greys/browns that
// merely lean warm sit under ~30% saturation in the same hue range. The
// wide gap to the next color cluster (steel-blue hulls at hue 180+) means
// this threshold isn't fragile to small palette changes on re-runs of the
// renderer pipeline.
function isOrangeAccent(uint h2, uint s2) pure returns (bool) {
    return h2 <= 45 && s2 >= 55;
}

// Variant 2's shiny tint: blendHSL barely moves a highly-saturated color's
// hue (only a 5% pull toward the new color when the base saturation is
// already > 40, see above), which is exactly backwards for variant 2's
// vivid orange accents -- they're the most visually dominant color on
// every piece, so under blendHSL they stay orange on every shiny ship
// instead of taking on a distinct identity. For those specific colors,
// this fully replaces hue and saturation with the ship's own (h, s)
// instead of blending -- equivalent to desaturating the orange to grey
// first, then recoloring it, since stripping a color's hue/saturation and
// reapplying new values *is* going through a grey midpoint -- while
// keeping the original lightness so shading/gradient detail across
// multiple orange-family COLOR_n values on the same piece stays intact.
// Every other color (structural greys, blues, etc.) keeps today's
// blendHSL behavior unchanged.
function blendHSLV2(
    uint h,
    uint s,
    uint l,
    string memory hslStringIn
) pure returns (string memory) {
    (uint h2, uint s2, uint l2) = parseHSL(hslStringIn);

    if (isOrangeAccent(h2, s2)) {
        return hslString(h, s, l2);
    }

    (uint blendedH, uint blendedS, uint blendedL) = blendValues(
        h,
        s,
        l,
        h2,
        s2,
        l2
    );
    return hslString(blendedH, blendedS, blendedL);
}

function parseUint(bytes memory b, uint start, uint end) pure returns (uint) {
    uint result = 0;
    for (uint i = start; i < end; i++) {
        if (uint8(b[i]) >= 48 && uint8(b[i]) <= 57) {
            result = result * 10 + (uint8(b[i]) - 48);
        }
    }
    return result;
}

function uintToString(uint value) pure returns (string memory) {
    if (value == 0) {
        return "0";
    }

    uint temp = value;
    uint digits;
    while (temp != 0) {
        digits++;
        temp /= 10;
    }

    bytes memory buffer = new bytes(digits);
    while (value != 0) {
        digits -= 1;
        buffer[digits] = bytes1(uint8(48 + uint(value % 10)));
        value /= 10;
    }

    return string(buffer);
}
