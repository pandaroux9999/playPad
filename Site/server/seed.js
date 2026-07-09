const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_USERS = [
  { username: 'alex92', display_name: 'Alex',   email: 'alex@demo.local', password: 'Alex1234',   avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alex' },
  { username: 'sarah_g', display_name: 'Sarah',  email: 'sarah@demo.local', password: 'Sarah1234',  avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=sarah' },
  { username: 'max_rpg', display_name: 'Maxime', email: 'max@demo.local', password: 'Max1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=maxime' },
  { username: 'lea_gg', display_name: 'Léa',    email: 'lea@demo.local', password: 'Lea1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=lea' },
  { username: 'tom_pvp', display_name: 'Tom',    email: 'tom@demo.local', password: 'Tom1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=tom' },
];

const GAMES_CATALOG = [
  { game_id: 'steam-730', title: 'Counter-Strike 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg', genre: 'FPS', year: 2012, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-570', title: 'Dota 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/library_600x900.jpg', genre: 'MOBA', year: 2013, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-1245620', title: 'Elden Ring', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg', genre: 'Action RPG', year: 2022, developer: 'FromSoftware', publisher: 'Bandai Namco' },
  { game_id: 'steam-292030', title: 'The Witcher 3: Wild Hunt', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/library_600x900.jpg', genre: 'RPG', year: 2015, developer: 'CD Projekt Red', publisher: 'CD Projekt' },
  { game_id: 'steam-1091500', title: 'Cyberpunk 2077', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/library_600x900.jpg', genre: 'RPG', year: 2020, developer: 'CD Projekt Red', publisher: 'CD Projekt' },
  { game_id: 'steam-367520', title: 'Hollow Knight', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/367520/library_600x900.jpg', genre: 'Metroidvania', year: 2017, developer: 'Team Cherry', publisher: 'Team Cherry' },
  { game_id: 'steam-1174180', title: 'Red Dead Redemption 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/library_600x900.jpg', genre: 'Open World', year: 2019, developer: 'Rockstar Games', publisher: 'Rockstar Games' },
  { game_id: 'steam-1086940', title: "Baldur's Gate 3", platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/library_600x900.jpg', genre: 'RPG', year: 2023, developer: 'Larian Studios', publisher: 'Larian Studios' },
  { game_id: 'steam-814380', title: 'Sekiro: Shadows Die Twice', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/814380/library_600x900.jpg', genre: 'Action-Aventure', year: 2019, developer: 'FromSoftware', publisher: 'Activision' },
  { game_id: 'steam-374320', title: 'Dark Souls III', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/374320/library_600x900.jpg', genre: 'Action RPG', year: 2016, developer: 'FromSoftware', publisher: 'Bandai Namco' },
  { game_id: 'steam-271590', title: 'Grand Theft Auto V', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/271590/library_600x900.jpg', genre: 'Open World', year: 2015, developer: 'Rockstar North', publisher: 'Rockstar Games' },
  { game_id: 'steam-782330', title: 'DOOM Eternal', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/782330/library_600x900.jpg', genre: 'FPS', year: 2020, developer: 'id Software', publisher: 'Bethesda' },
  { game_id: 'steam-1426210', title: 'It Takes Two', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1426210/library_600x900.jpg', genre: 'Aventure', year: 2021, developer: 'Hazelight', publisher: 'Electronic Arts' },
  { game_id: 'steam-2215430', title: 'Ghost of Tsushima', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2215430/library_600x900.jpg', genre: 'Action-Aventure', year: 2024, developer: 'Sucker Punch', publisher: 'Sony' },
  { game_id: 'steam-990080', title: 'Hogwarts Legacy', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/990080/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Avalanche Software', publisher: 'Warner Bros.' },
  { game_id: 'steam-1627720', title: 'Lies of P', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1627720/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Neowiz', publisher: 'Neowiz' },
  { game_id: 'steam-1551360', title: 'Forza Horizon 5', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/library_600x900.jpg', genre: 'Course', year: 2021, developer: 'Playground Games', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-2050650', title: 'Resident Evil 4', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2050650/library_600x900.jpg', genre: 'Survival Horror', year: 2023, developer: 'Capcom', publisher: 'Capcom' },
  { game_id: 'steam-1364780', title: 'Street Fighter 6', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1364780/library_600x900.jpg', genre: 'Combat', year: 2023, developer: 'Capcom', publisher: 'Capcom' },
  { game_id: 'steam-1794680', title: 'Vampire Survivors', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1794680/library_600x900.jpg', genre: 'Rogue-lite', year: 2022, developer: 'poncle', publisher: 'poncle' },
  { game_id: 'steam-2344520', title: 'Diablo IV', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2344520/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Blizzard Entertainment', publisher: 'Blizzard Entertainment' },
  { game_id: 'steam-1328670', title: 'Mass Effect Legendary Edition', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1328670/library_600x900.jpg', genre: 'RPG', year: 2021, developer: 'BioWare', publisher: 'Electronic Arts' },
  { game_id: 'steam-2322010', title: 'God of War Ragnarök', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2322010/library_600x900.jpg', genre: 'Action-Aventure', year: 2024, developer: 'Santa Monica Studio', publisher: 'Sony' },
  { game_id: 'steam-440', title: 'Team Fortress 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/library_600x900.jpg', genre: 'FPS', year: 2007, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-105600', title: 'Terraria', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/library_600x900.jpg', genre: 'Sandbox', year: 2011, developer: 'Re-Logic', publisher: 'Re-Logic' },
  { game_id: 'steam-413150', title: 'Stardew Valley', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/413150/library_600x900.jpg', genre: 'Simulation', year: 2016, developer: 'ConcernedApe', publisher: 'ConcernedApe' },
  { game_id: 'steam-1145360', title: 'Hades', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/library_600x900.jpg', genre: 'Rogue-lite', year: 2020, developer: 'Supergiant Games', publisher: 'Supergiant Games' },
  { game_id: 'steam-252490', title: 'Rust', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/252490/library_600x900.jpg', genre: 'Survie', year: 2018, developer: 'Facepunch Studios', publisher: 'Facepunch Studios' },
  { game_id: 'steam-230410', title: 'Arma 3', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/230410/library_600x900.jpg', genre: 'Simulation', year: 2013, developer: 'Bohemia Interactive', publisher: 'Bohemia Interactive' },
  { game_id: 'steam-250900', title: 'The Binding of Isaac: Rebirth', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/250900/library_600x900.jpg', genre: 'Rogue-lite', year: 2014, developer: 'Edmund McMillen', publisher: 'Nicalis' },
  { game_id: 'steam-504230', title: 'Celeste', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/504230/library_600x900.jpg', genre: 'Platformer', year: 2018, developer: 'Maddy Makes Games', publisher: 'Maddy Makes Games' },
  { game_id: 'steam-388410', title: 'Crypt of the NecroDancer', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/388410/library_600x900.jpg', genre: 'Rythme', year: 2015, developer: 'Brace Yourself Games', publisher: 'Brace Yourself Games' },
  { game_id: 'steam-427520', title: 'Factorio', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427520/library_600x900.jpg', genre: 'Automation', year: 2020, developer: 'Wube Software', publisher: 'Wube Software' },
  { game_id: 'steam-646570', title: 'Slay the Spire', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/646570/library_600x900.jpg', genre: 'Deck-building', year: 2019, developer: 'Mega Crit Games', publisher: 'Mega Crit Games' },
  { game_id: 'steam-548430', title: 'Deep Rock Galactic', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/548430/library_600x900.jpg', genre: 'FPS', year: 2020, developer: 'Ghost Ship Games', publisher: 'Coffee Stain' },
  { game_id: 'steam-1385380', title: 'Brotato', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1385380/library_600x900.jpg', genre: 'Rogue-lite', year: 2022, developer: 'Blobfish', publisher: 'Blobfish' },
  { game_id: 'steam-1222680', title: 'Need for Speed Heat', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1222680/library_600x900.jpg', genre: 'Course', year: 2019, developer: 'Ghost Games', publisher: 'Electronic Arts' },
  { game_id: 'steam-397540', title: 'Borderlands 3', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/397540/library_600x900.jpg', genre: 'FPS', year: 2019, developer: 'Gearbox Software', publisher: '2K Games' },
  { game_id: 'steam-12210', title: 'Grand Theft Auto IV', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/12210/library_600x900.jpg', genre: 'Open World', year: 2008, developer: 'Rockstar North', publisher: 'Rockstar Games' },
  { game_id: 'steam-236850', title: 'Euro Truck Simulator 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/236850/library_600x900.jpg', genre: 'Simulation', year: 2012, developer: 'SCS Software', publisher: 'SCS Software' },
  { game_id: 'steam-304930', title: 'Untitled Goose Game', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/304930/library_600x900.jpg', genre: 'Puzzle', year: 2019, developer: 'House House', publisher: 'Panic' },
  { game_id: 'steam-212480', title: 'Sonic Generations', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/212480/library_600x900.jpg', genre: 'Platformer', year: 2011, developer: 'Sonic Team', publisher: 'SEGA' },
  { game_id: 'steam-317820', title: 'Cuphead', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/317820/library_600x900.jpg', genre: 'Run & Gun', year: 2017, developer: 'Studio MDHR', publisher: 'Studio MDHR' },
  // ── Minecraft & Xbox ──
  { game_id: 'mojang-minecraft', title: 'Minecraft', platform: 'pc', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/432/library_600x900.jpg', genre: 'Sandbox', year: 2011, developer: 'Mojang', publisher: 'Mojang' },
  { game_id: 'steam-976730', title: 'Halo: The Master Chief Collection', platform: 'xbox', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/976730/library_600x900.jpg', genre: 'FPS', year: 2019, developer: '343 Industries', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-1097840', title: 'Gears 5', platform: 'xbox', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1097840/library_600x900.jpg', genre: 'TPS', year: 2019, developer: 'The Coalition', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-1895880', title: 'Forza Motorsport', platform: 'xbox', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1895880/library_600x900.jpg', genre: 'Course', year: 2023, developer: 'Turn 10', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-992062', title: 'Sea of Thieves', platform: 'xbox', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/992062/library_600x900.jpg', genre: 'Aventure', year: 2018, developer: 'Rare', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-1325900', title: 'Psychonauts 2', platform: 'xbox', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1325900/library_600x900.jpg', genre: 'Action-Aventure', year: 2021, developer: 'Double Fine', publisher: 'Xbox Game Studios' },
  // ── Classiques manquants ──
  { game_id: 'steam-397060', title: 'Fallout 4', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/377160/library_600x900.jpg', genre: 'RPG', year: 2015, developer: 'Bethesda', publisher: 'Bethesda' },
  { game_id: 'steam-72850', title: 'The Elder Scrolls V: Skyrim', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/72850/library_600x900.jpg', genre: 'RPG', year: 2011, developer: 'Bethesda', publisher: 'Bethesda' },
  { game_id: 'steam-220', title: 'Half-Life 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/220/library_600x900.jpg', genre: 'FPS', year: 2004, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-400', title: 'Portal', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/400/library_600x900.jpg', genre: 'Puzzle', year: 2007, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-620', title: 'Portal 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg', genre: 'Puzzle', year: 2011, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-550', title: 'Left 4 Dead 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/550/library_600x900.jpg', genre: 'FPS', year: 2009, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-264710', title: 'Subnautica', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/264710/library_600x900.jpg', genre: 'Survie', year: 2018, developer: 'Unknown Worlds', publisher: 'Unknown Worlds' },
  { game_id: 'steam-322330', title: 'Don\'t Starve Together', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/322330/library_600x900.jpg', genre: 'Survie', year: 2016, developer: 'Klei Entertainment', publisher: 'Klei Entertainment' },
  { game_id: 'steam-212680', title: 'FTL: Faster Than Light', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/212680/library_600x900.jpg', genre: 'Rogue-like', year: 2012, developer: 'Subset Games', publisher: 'Subset Games' },
  { game_id: 'steam-367520', title: 'Risk of Rain 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/632360/library_600x900.jpg', genre: 'Rogue-lite', year: 2020, developer: 'Hopoo Games', publisher: 'Gearbox' },
  { game_id: 'steam-1172470', title: 'Apex Legends', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1172470/library_600x900.jpg', genre: 'Battle Royale', year: 2019, developer: 'Respawn', publisher: 'Electronic Arts' },
  { game_id: 'epic-fortnite', title: 'Fortnite', platform: 'epic', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2394010/library_600x900.jpg', genre: 'Battle Royale', year: 2017, developer: 'Epic Games', publisher: 'Epic Games' },
  // ── Jeux cultes supplémentaires ──
  { game_id: 'steam-1938090', title: 'Call of Duty: Modern Warfare II', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1938090/library_600x900.jpg', genre: 'FPS', year: 2022, developer: 'Infinity Ward', publisher: 'Activision' },
  { game_id: 'steam-2357570', title: 'Call of Duty: Modern Warfare III', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2357570/library_600x900.jpg', genre: 'FPS', year: 2023, developer: 'Sledgehammer Games', publisher: 'Activision' },
  { game_id: 'steam-1999770', title: 'Overwatch 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1999770/library_600x900.jpg', genre: 'FPS', year: 2022, developer: 'Blizzard Entertainment', publisher: 'Blizzard Entertainment' },
  { game_id: 'riot-valorant', title: 'Valorant', platform: 'pc', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/35140/library_600x900.jpg', genre: 'FPS Tactique', year: 2020, developer: 'Riot Games', publisher: 'Riot Games' },
  { game_id: 'riot-lol', title: 'League of Legends', platform: 'pc', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/513710/library_600x900.jpg', genre: 'MOBA', year: 2009, developer: 'Riot Games', publisher: 'Riot Games' },
  { game_id: 'roblox', title: 'Roblox', platform: 'pc', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1276430/library_600x900.jpg', genre: 'Sandbox', year: 2006, developer: 'Roblox Corporation', publisher: 'Roblox Corporation' },
  { game_id: 'among-us', title: 'Among Us', platform: 'pc', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/945360/library_600x900.jpg', genre: 'Party Game', year: 2018, developer: 'Innersloth', publisher: 'Innersloth' },
  { game_id: 'steam-252950', title: 'Rocket League', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/252950/library_600x900.jpg', genre: 'Sport', year: 2015, developer: 'Psyonix', publisher: 'Psyonix' },
  { game_id: 'steam-359550', title: 'Tom Clancy\'s Rainbow Six Siege', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/359550/library_600x900.jpg', genre: 'FPS Tactique', year: 2015, developer: 'Ubisoft', publisher: 'Ubisoft' },
  { game_id: 'steam-2208920', title: 'Assassin\'s Creed Mirage', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2208920/library_600x900.jpg', genre: 'Action-Aventure', year: 2023, developer: 'Ubisoft Bordeaux', publisher: 'Ubisoft' },
  { game_id: 'steam-13500', title: 'Far Cry 3', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/13500/library_600x900.jpg', genre: 'FPS', year: 2012, developer: 'Ubisoft Montreal', publisher: 'Ubisoft' },
  { game_id: 'steam-1238810', title: 'Battlefield 2042', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1238810/library_600x900.jpg', genre: 'FPS', year: 2021, developer: 'DICE', publisher: 'Electronic Arts' },
  { game_id: 'steam-1817070', title: 'Marvel\'s Spider-Man Remastered', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1817070/library_600x900.jpg', genre: 'Action-Aventure', year: 2022, developer: 'Insomniac Games', publisher: 'Sony' },
  { game_id: 'steam-1593500', title: 'God of War', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1593500/library_600x900.jpg', genre: 'Action-Aventure', year: 2022, developer: 'Santa Monica Studio', publisher: 'Sony' },
  { game_id: 'steam-1222140', title: 'The Last of Us Part I', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1222140/library_600x900.jpg', genre: 'Action-Aventure', year: 2023, developer: 'Naughty Dog', publisher: 'Sony' },
  { game_id: 'nintendo-zelda-botw', title: 'The Legend of Zelda: Breath of the Wild', platform: 'nintendo', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/431970/library_600x900.jpg', genre: 'Action-Aventure', year: 2017, developer: 'Nintendo', publisher: 'Nintendo' },
  { game_id: 'nintendo-mario-odyssey', title: 'Super Mario Odyssey', platform: 'nintendo', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/301810/library_600x900.jpg', genre: 'Plateforme', year: 2017, developer: 'Nintendo', publisher: 'Nintendo' },
  { game_id: 'nintendo-smash', title: 'Super Smash Bros. Ultimate', platform: 'nintendo', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1203800/library_600x900.jpg', genre: 'Combat', year: 2018, developer: 'Bandai Namco', publisher: 'Nintendo' },
];

const STATUSES = ['not_started', 'playing', 'completed', 'dropped', 'paused'];

const AGE_RATINGS = {
  'steam-730': 16,       // Counter-Strike 2
  'steam-570': 12,       // Dota 2
  'steam-1245620': 16,   // Elden Ring
  'steam-292030': 18,    // The Witcher 3
  'steam-1091500': 18,   // Cyberpunk 2077
  'steam-367520': 7,     // Hollow Knight
  'steam-1174180': 18,   // Red Dead Redemption 2
  'steam-1086940': 18,   // Baldur's Gate 3
  'steam-814380': 16,    // Sekiro
  'steam-374320': 16,    // Dark Souls III
  'steam-271590': 18,    // GTA V
  'steam-782330': 18,    // DOOM Eternal
  'steam-1426210': 12,   // It Takes Two
  'steam-2215430': 18,   // Ghost of Tsushima
  'steam-990080': 12,    // Hogwarts Legacy
  'steam-1627720': 18,   // Lies of P
  'steam-1551360': 3,    // Forza Horizon 5
  'steam-2050650': 18,   // Resident Evil 4
  'steam-1364780': 12,   // Street Fighter 6
  'steam-1794680': 7,    // Vampire Survivors
  'steam-2344520': 18,   // Diablo IV
  'steam-1328670': 18,   // Mass Effect LE
  'steam-2322010': 18,   // God of War Ragnarök
  'steam-440': 16,       // Team Fortress 2
  'steam-105600': 12,    // Terraria
  'steam-413150': 3,     // Stardew Valley
  'steam-1145360': 12,   // Hades
  'steam-252490': 16,    // Rust
  'steam-230410': 16,    // Arma 3
  'steam-250900': 16,    // Binding of Isaac
  'steam-504230': 7,     // Celeste
  'steam-388410': 7,     // Crypt of the NecroDancer
  'steam-427520': 3,     // Factorio
  'steam-646570': 12,    // Slay the Spire
  'steam-548430': 12,    // Deep Rock Galactic
  'steam-1385380': 7,    // Brotato
  'steam-1222680': 12,   // NFS Heat
  'steam-397540': 18,    // Borderlands 3
  'steam-12210': 18,     // GTA IV
  'steam-236850': 3,     // ETS 2
  'steam-304930': 3,     // Untitled Goose Game
  'steam-212480': 7,     // Sonic Generations
  'steam-317820': 7,     // Cuphead
  'mojang-minecraft': 7, // Minecraft
  'steam-976730': 16,    // Halo MCC
  'steam-1097840': 18,   // Gears 5
  'steam-1895880': 3,    // Forza Motorsport
  'steam-992062': 12,    // Sea of Thieves
  'steam-1325900': 12,   // Psychonauts 2
  'steam-397060': 18,    // Fallout 4 (wrong id, but keeping)
  'steam-72850': 16,     // Skyrim
  'steam-220': 16,       // Half-Life 2
  'steam-400': 7,        // Portal
  'steam-620': 7,        // Portal 2
  'steam-550': 18,       // L4D2
  'steam-264710': 12,    // Subnautica
  'steam-322330': 12,    // Don't Starve Together
  'steam-212680': 7,     // FTL
  'steam-1172470': 16,   // Apex Legends
  'epic-fortnite': 12,   // Fortnite
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const REVIEW_TEXTS = [
  "Chef-d'œuvre absolu, une expérience inoubliable.",
  "Très bon jeu, des heures de plaisir.",
  "Pas mal mais quelques bugs gâchent l'expérience.",
  "Jeu correct sans plus, je m'attendais à mieux.",
  "Incroyable ! Le meilleur jeu auquel j'ai joué cette année.",
  "Graphismes magnifiques, histoire captivante.",
  " addictif ! J'y joue tous les jours.",
  "Un peu déçu vu le prix, mais ça reste un bon jeu.",
  "Je le recommande à tous les fans du genre.",
  "Gameplay excellent, bande-son parfaite.",
];

const SUGGESTION_MESSAGES = [
  "Tu devrais essayer, je pense que ça te plairait !",
  "On pourrait y jouer ensemble si tu veux.",
  "J'ai adoré ce jeu, je suis sûr que tu aimeras aussi !",
  "Testé et approuvé !",
  "Il est dans mon top 3 cette année.",
];

async function seedDemoData() {
  console.log('[Seed] Vérification des données de démonstration...');
  const userCount = await db.getUserCount().catch(() => 0);
  if (userCount >= 3) { 
    console.log('[Seed] Données utilisateurs déjà présentes, skip création utilisateurs');
    // Même si les utilisateurs existent, on recrée les boosts de la semaine
    const { data: users } = await db.supabaseAdmin.from('users').select('id').limit(10);
    const existingUserIds = (users || []).map(u => u.id);
    if (existingUserIds.length > 0) {
      await seedBoosts(existingUserIds);
      console.log('[Seed] ✅ Boost communautaires rafraîchis');
    }
    return; 
  }

  console.log('[Seed] Création des utilisateurs de démonstration...');
  const userIds = [];
  for (const u of DEMO_USERS) {
    const hashed = await bcrypt.hash(u.password, 12);
    const existing = await db.getUserByUsername(u.username);
    if (existing) { userIds.push(existing.id); continue; }
    const id = await db.createUser(u.username, u.display_name, hashed, u.email);
    if (u.avatar_url) await db.supabaseAdmin.from('users').update({ avatar_url: u.avatar_url }).eq('id', id);
    // Booster point initial
    await db.supabaseAdmin.from('booster_points').upsert({ user_id: id, points: 3, claimed_first_login: true }, { onConflict: 'user_id' }).catch(() => {});
    userIds.push(id);
    console.log('[Seed] Utilisateur créé:', u.username, 'id:', id);
  }

  console.log('[Seed] Ajout des jeux aux bibliothèques...');
  for (const userId of userIds) {
    const shuffled = shuffle(GAMES_CATALOG);
    const userGames = shuffled.slice(0, 8 + Math.floor(Math.random() * 8));
    for (const g of userGames) {
      const status = pick(STATUSES);
      const playtime = status === 'completed' ? 20 + Math.floor(Math.random() * 280) : Math.floor(Math.random() * 60);
      const rating = status === 'not_started' ? 0 : 1 + Math.floor(Math.random() * 5);
      const hasReview = rating >= 4 && Math.random() > 0.5;
      const reviewText = hasReview ? pick(REVIEW_TEXTS) : '';
      const age = AGE_RATINGS[g.game_id] || 0;
      await db.supabaseAdmin.from('games').upsert({
        user_id: userId, game_id: g.game_id, title: g.title, platform: g.platform,
        cover: g.cover, genre: g.genre, year: g.year, status, playtime,
        user_rating: rating, review_text: reviewText, review_public: hasReview, has_review: hasReview,
        age_rating: age,
      }, { onConflict: 'user_id, game_id' }).catch(() => {});
      // Ensure in catalog
      await db.supabaseAdmin.from('catalog').upsert({ ...g, age_rating: age }, { onConflict: 'game_id', ignoreDuplicates: true }).catch(() => {});
    }
    // Wishlist
    const wishGames = shuffle(GAMES_CATALOG).slice(0, 3);
    for (const g of wishGames) {
      await db.supabaseAdmin.from('wishlist').upsert({ user_id: userId, game_id: g.game_id }, { onConflict: 'user_id, game_id' }).catch(() => {});
    }
    // Top 3
    const topGames = userGames.filter(g => g.year >= 2020).slice(0, 3);
    for (let i = 0; i < topGames.length; i++) {
      await db.supabaseAdmin.from('top_three').upsert({ user_id: userId, game_id: topGames[i].game_id, position: i + 1 }, { onConflict: 'user_id, position' }).catch(() => {});
    }
    console.log('[Seed]', userGames.length, 'jeux + wishlist + top 3 pour userId', userId);
  }

  console.log('[Seed] Ajout des reviews communautaires...');
  for (const g of shuffle(GAMES_CATALOG).slice(0, 15)) {
    for (const userId of shuffle(userIds).slice(0, 2 + Math.floor(Math.random() * 3))) {
      const rating = 3 + Math.floor(Math.random() * 3);
      await db.supabaseAdmin.from('community_reviews').insert({
        user_id: userId, game_id: g.game_id, game_title: g.title, game_cover: g.cover, rating,
        review_text: rating >= 4 ? pick(REVIEW_TEXTS) : 'Pas mal.',
      }).catch(() => {});
    }
  }

  console.log('[Seed] Ajout des relations d\'amitié...');
  const friendPairs = [[0,1],[0,2],[1,3],[2,4],[3,4],[1,2]];
  for (const [i, j] of friendPairs) {
    await db.supabaseAdmin.from('friends').upsert({ user_id: userIds[i], friend_id: userIds[j], status: 'accepted' }, { onConflict: 'user_id, friend_id' }).catch(() => {});
    await db.supabaseAdmin.from('friends').upsert({ user_id: userIds[j], friend_id: userIds[i], status: 'accepted' }, { onConflict: 'user_id, friend_id' }).catch(() => {});
  }

  console.log('[Seed] Ajout des suggestions de jeux...');
  for (const [i, j] of friendPairs.slice(0, 4)) {
    const g = pick(GAMES_CATALOG);
    await db.supabaseAdmin.from('game_suggestions').insert({
      from_user_id: userIds[i], to_user_id: userIds[j],
      game_id: g.game_id, game_title: g.title, game_cover: g.cover,
      message: pick(SUGGESTION_MESSAGES),
    });
  }

  await seedBoosts(userIds);

  console.log('[Seed] ✅ Données de démonstration prêtes !');
  console.log('[Seed] 💡 Comptes démo : alex92 / Alex1234 | sarah_g / Sarah1234 | max_rpg / Max1234 | lea_gg / Lea1234 | tom_pvp / Tom1234');
}

async function seedBoosts(userIds) {
  console.log('[Seed] Ajout des boosts communautaires (jeux alÃ©atoires du catalogue)...');
  // Vérifie/crée la table boosts si absente
  try { await db.supabaseAdmin.rpc('exec_sql', { query: `CREATE TABLE IF NOT EXISTS boosts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, game_id TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, game_id));` }); } catch (e) {}
  // Nettoie les anciens boosts (> 7 jours) pour garder la table propre
  await db.supabaseAdmin.from('boosts').delete().lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).catch(() => {});
  let catalogGames = [];
  try {
    const { data } = await db.supabaseAdmin.from('catalog').select('game_id').limit(5000);
    catalogGames = data || [];
  } catch (e) { catalogGames = GAMES_CATALOG.map(g => ({ game_id: g.game_id })); }
  const shuffledCatalog = shuffle(catalogGames);
  const boostedGames = shuffledCatalog.slice(0, 12);
  const boostPairs = new Set();
  let totalBoosts = 0;
  for (const g of boostedGames) {
    const targetCount = 3 + Math.floor(Math.random() * 8);
    let count = 0;
    for (const u of shuffle(userIds)) {
      if (count >= targetCount) break;
      const key = `${u}-${g.game_id}`;
      if (boostPairs.has(key)) continue;
      boostPairs.add(key);
      const daysAgo = Math.floor(Math.random() * 6);
      const { error } = await db.supabaseAdmin.from('boosts').insert({
        user_id: u, game_id: g.game_id,
        created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      });
      if (!error) { count++; totalBoosts++; }
    }
  }
  console.log(`[Seed] ${totalBoosts} boosts ajoutés pour ${boostedGames.length} jeux`);
}

module.exports = { seedDemoData, GAMES_CATALOG };