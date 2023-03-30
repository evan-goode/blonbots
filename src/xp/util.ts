import repl from "repl";

import _ from "lodash";

export const ORB_INGEST_RATE = 10; // player can ingest 1 orb every 2 gt
export const MAX_DROPPED_XP = 100;

export const levelToExperience = function levelToExperience(level: number) {
	// https://minecraft.gamepedia.com/Experience#Leveling_up
	if (level <= 16) {
		return level * level + 6 * level;
	} else if (level <= 31) {
		return 2.5 * level * level - 40.5 * level + 360;
	} else {
		return 4.5 * level * level - 162.5 * level + 2220;
	}
};

export const experienceToLevel = function experienceToLevel(points: number) {
	// inverted by hand from levelToExperience
	if (points <= 352) {
		return Math.floor(Math.sqrt(9 + points) - 3);
	} else if (points <= 1507) {
		return Math.floor((40.5 + Math.sqrt(10 * points - 1959.75)) / 5);
	} else {
		return Math.floor((162.5 + Math.sqrt(18 * points - 13553.75)) / 9);
	}
}

export const roundToOrbSize = function roundToOrbSize(value: number) {
	// net/minecraft/entity/ExperienceOrbEntity.java
	if (value >= 2477) {
		return 2477;
	} else if (value >= 1237) {
		return 1237;
	} else if (value >= 617) {
		return 617;
	} else if (value >= 307) {
		return 307;
	} else if (value >= 149) {
		return 149;
	} else if (value >= 73) {
		return 73;
	} else if (value >= 37) {
		return 37;
	} else if (value >= 17) {
		return 17;
	} else if (value >= 7) {
		return 7;
	} else {
		return value >= 3 ? 3 : 1;
	}
};

export const dropXp = function dropXp(level: number) {
	// net/minecraft/entity/LivingEntity.java
	let i = Math.min(level * 7, MAX_DROPPED_XP);
	const orbs = [];
	while (i > 0) {
		const orb = roundToOrbSize(i);
		i -= orb;
		orbs.push(orb);
	}
	return orbs;
};

export const levelDifference = function levelDifference(
	startLevel: number,
	endLevel: number
) {
	return levelToExperience(endLevel) - levelToExperience(startLevel);
};

// PLAYGROUND

// const level = experienceToLevel(200);
// for (const level of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
// 	const density = _.sum(dropXp(level)) / dropXp(level).length;
// 	console.log(level, dropXp(level), density);
// }
