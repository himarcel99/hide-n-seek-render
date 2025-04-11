// Import necessary modules
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
// Initialize Socket.IO server
const io = new Server(server);

// Define the port, using environment variable or default to 3000
const PORT = process.env.PORT || 3000;

// Serve static files (like index.html, client.js, css, sounds) from the 'public' directory
// IMPORTANT: Your index.html, client.js, and sounds folder must be inside a 'public' folder
// in the same directory as server.js for this to work.
app.use(express.static(path.join(__dirname, 'public')));

// --- Define Sound File Paths ---
// Arrays holding the relative paths to the sound files within the 'public' directory
const baseAnimalSounds = [
    '/sounds/chicken.mp3', '/sounds/horse.mp3', '/sounds/cow.mp3', '/sounds/sheep.mp3',
    '/sounds/pig.mp3', '/sounds/cat.mp3', '/sounds/dog.mp3', '/sounds/bird.mp3'
];
const baseUnfoundSounds = [
    '/sounds/unfound1.mp3', '/sounds/unfound2.mp3', '/sounds/unfound3.mp3', '/sounds/unfound4.mp3',
    '/sounds/unfound5.mp3', '/sounds/unfound6.mp3', '/sounds/unfound7.mp3', '/sounds/unfound8.mp3'
];
// Warning if sound arrays have different lengths, as they are paired
if (baseAnimalSounds.length !== baseUnfoundSounds.length) {
    console.warn("Warning: Number of animal sounds does not match number of unfound sounds.");
}
const numUniqueSounds = baseAnimalSounds.length;

// In-memory store for all active game rooms and their states
const rooms = {};


/**
 * Generates a unique 5-character room code using only uppercase letters.
 * Ensures the generated code is not already in use.
 * @returns {string} A unique 5-character room code.
 */
function generateRoomCode() {
    let code;
    // Use only letters for the room code for simplicity
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    do {
        code = '';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms[code]); // Ensure uniqueness by checking if the code already exists
    return code;
}

/**
 * Creates a safe-to-send representation of the room state for clients.
 * Omits server-internal details (like interval IDs) and includes necessary info like sound URLs and roles.
 * @param {string} roomCode - The code of the room to get the state for.
 * @returns {object | null} A filtered room state object suitable for sending to clients, or null if the room doesn't exist.
 */
function getRoomStateForClient(roomCode) {
    if (!rooms[roomCode]) return null; // Return null if room doesn't exist

    const room = rooms[roomCode];
    const playersForClient = {};
    // Create a player object for the client, including sound URLs and role for preloading/UI logic
    Object.values(room.players).forEach(p => {
        playersForClient[p.id] = {
            id: p.id,
            number: p.number,
            role: p.role, // Role is needed for client-side logic (like showing Hider controls)
            isReady: p.isReady, // Needed for Hiding phase status
            isFound: p.isFound, // Needed for Seeking/Game Over status
            // Include sound URLs so the client can preload them
            uniqueAnimalSoundURL: p.uniqueAnimalSoundURL,
            uniqueUnfoundSoundURL: p.uniqueUnfoundSoundURL
        };
    });

    // Return the filtered state object
    return {
        roomCode: room.roomCode,
        players: playersForClient, // Send filtered player details including role
        gameState: room.gameState,
        seekTimeLimit: room.seekTimeLimit,
        seekStartTime: room.seekStartTime, // Needed for client-side timer display
        winner: room.winner,
        activeUnfoundPlayerId: room.activeUnfoundPlayerId, // Needed for Game Over reveal UI
    };
}

/**
 * Broadcasts the current, filtered room state to all clients connected to that room.
 * @param {string} roomCode - The code of the room to update.
 */
function broadcastUpdateState(roomCode) {
    const state = getRoomStateForClient(roomCode); // Get the client-safe state
    if (state) {
        io.to(roomCode).emit('updateState', state); // Emit the 'updateState' event to the room
        console.log(`[${roomCode}] Broadcasted state: ${state.gameState}`);
    }
}

/**
 * Clears all game-related intervals and timeouts associated with a specific room.
 * Resets related state variables. Important for stopping game loops and timers correctly.
 * @param {string} roomCode - The code of the room to clear intervals for.
 */
function clearGameIntervals(roomCode) {
    const room = rooms[roomCode];
    if (!room) return; // Do nothing if room doesn't exist

    // Clear any active intervals/timeouts
    if (room.preSeekCountdownInterval) clearInterval(room.preSeekCountdownInterval);
    if (room.seekTimerInterval) clearInterval(room.seekTimerInterval);
    if (room.soundRotationTimeout) clearTimeout(room.soundRotationTimeout);

    // Reset interval/timeout IDs and related state
    room.preSeekCountdownInterval = null;
    room.seekTimerInterval = null;
    room.soundRotationTimeout = null;
    room.activeUnfoundPlayerId = null; // Reset active player for reveal
    room.unfoundPlayerQueue = []; // Clear reveal queue
    room.nextPlayerIndexToPlay = 0; // Reset sound rotation index
    console.log(`[${roomCode}] Cleared game intervals.`);
}


/**
 * Checks if all players in a room have been found (Seekers win condition).
 * If the condition is met, it ends the game with 'Seekers' as the winner.
 * @param {string} roomCode - The code of the room to check.
 * @returns {boolean} True if the Seekers win condition is met, false otherwise.
 */
function checkSeekerWin(roomCode) {
    const room = rooms[roomCode];
    // Only check if the game is currently in the 'Seeking' state
    if (!room || room.gameState !== 'Seeking') return false;

    // Check if every player in the room has the 'isFound' flag set to true
    const allFound = Object.values(room.players).every(p => p.isFound);
    if (allFound) {
        console.log(`[${roomCode}] Seekers win condition met.`);
        endGame(roomCode, 'Seekers'); // End the game, declaring Seekers as winners
        return true;
    }
    return false;
}

/**
 * Ends the current game in the specified room.
 * Sets the game state to 'GameOver', declares the winner, clears intervals,
 * and initiates the appropriate end-game sequence (reveal or victory sound).
 * @param {string} roomCode - The code of the room where the game is ending.
 * @param {'Hider' | 'Seekers'} winner - The declared winner of the game.
 */
function endGame(roomCode, winner) {
    const room = rooms[roomCode];
    // Prevent ending the game multiple times or if the room doesn't exist
    if (!room || room.gameState === 'GameOver') return;

    console.log(`[${roomCode}] Game Over. Winner: ${winner}`);
    clearGameIntervals(roomCode); // Stop all active game timers/loops

    // Update game state
    room.gameState = 'GameOver';
    room.winner = winner;

    // Trigger appropriate follow-up actions based on the winner
    if (winner === 'Hider') {
        startGameOverReveal(roomCode); // Start the reveal sequence for unfound phones
    } else if (winner === 'Seekers') {
        io.to(roomCode).emit('playVictoryMelody'); // Tell clients to play the victory sound
        broadcastUpdateState(roomCode); // Send the final state update
    } else {
        // Should not happen with current logic, but broadcast state just in case
        broadcastUpdateState(roomCode);
    }
}


// --- Game Over Reveal Functions (for Hider Win) ---

/**
 * Starts the Hider Win reveal sequence.
 * Creates a queue of unfound players and activates the first one.
 * @param {string} roomCode - The room where the Hider won.
 */
function startGameOverReveal(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.winner !== 'Hider') return; // Only proceed if Hider won

    // Create a queue of IDs of players who were not found, sorted by player number
    room.unfoundPlayerQueue = Object.values(room.players)
        .filter(p => !p.isFound) // Filter for unfound players
        .sort((a, b) => a.number - b.number) // Sort by player number
        .map(p => p.id); // Get just the IDs

    console.log(`[${roomCode}] Starting Hider Win reveal. Queue:`, room.unfoundPlayerQueue);
    activateNextUnfoundPlayer(roomCode); // Activate the first player in the queue
}

/**
 * Activates the next player in the unfound queue for the Hider Win reveal.
 * Sends a message to that specific player's client telling it to start playing its "unfound" sound.
 * Updates the room state to reflect who is currently active.
 * @param {string} roomCode - The room where the reveal is happening.
 */
function activateNextUnfoundPlayer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.activeUnfoundPlayerId = null; // Reset the currently active player

    // If the queue is empty, the reveal is over
    if (room.unfoundPlayerQueue.length === 0) {
        console.log(`[${roomCode}] Reveal queue empty or finished.`);
        broadcastUpdateState(roomCode); // Update state one last time
        return;
    }

    // Get the next player ID from the front of the queue
    const nextPlayerId = room.unfoundPlayerQueue.shift();
    room.activeUnfoundPlayerId = nextPlayerId; // Set this player as active

    const player = room.players[nextPlayerId];
    // Check if player exists and has an assigned unfound sound URL
    if (player && player.uniqueUnfoundSoundURL) {
        // Emit 'becomeActiveUnfound' only to the specific player's socket
        io.to(nextPlayerId).emit('becomeActiveUnfound', { soundURL: player.uniqueUnfoundSoundURL });
        console.log(`[${roomCode}] Activating player ${player.number} (${nextPlayerId}) for reveal with sound ${player.uniqueUnfoundSoundURL}.`);
    } else {
        // If player or sound is missing (shouldn't normally happen), log it and skip to the next
        console.log(`[${roomCode}] Player ${nextPlayerId} or their unfound sound not found during reveal activation. Skipping.`);
        activateNextUnfoundPlayer(roomCode); // Immediately try the next player
        return; // Return here to avoid broadcasting state unnecessarily for the skipped player
    }

    broadcastUpdateState(roomCode); // Update all clients with the new active player
}

// --- Hiding Phase Functions ---

/**
 * Starts the 10-second countdown before the Seeking phase begins.
 * Emits 'preSeekCountdown' events to all clients in the room every second.
 * @param {string} roomCode - The room where the countdown should start.
 */
function startPreSeekCountdown(roomCode) {
    const room = rooms[roomCode];
    // Prevent starting multiple countdowns
    if (!room || room.preSeekCountdownInterval) return;

    console.log(`[${roomCode}] Starting pre-seek countdown.`);
    room.preSeekCountdownValue = 10; // Start countdown from 10
    io.to(roomCode).emit('preSeekCountdown', room.preSeekCountdownValue); // Emit initial value

    // Set up an interval to decrement and emit the countdown value every second
    room.preSeekCountdownInterval = setInterval(() => {
        room.preSeekCountdownValue--;
        io.to(roomCode).emit('preSeekCountdown', room.preSeekCountdownValue);

        // When countdown reaches 0, clear the interval and start the Seeking phase
        if (room.preSeekCountdownValue <= 0) {
            clearInterval(room.preSeekCountdownInterval);
            room.preSeekCountdownInterval = null;
            startSeekingPhase(roomCode); // Transition to the next phase
        }
    }, 1000);
}

// --- Seeking Phase Functions ---

/**
 * Initiates the Seeking Phase for the specified room.
 * Sets the game state, records the start time, calculates sound delay,
 * starts the main seek timer, and schedules the very first sound to play after a delay.
 * @param {string} roomCode - The room where the seeking phase should start.
 */
function startSeekingPhase(roomCode) {
    const room = rooms[roomCode];
    // Prevent starting the phase multiple times or if the room doesn't exist
    if (!room || room.gameState === 'Seeking') return;

    console.log(`[${roomCode}] Starting Seeking Phase.`);
    room.gameState = 'Seeking';
    room.seekStartTime = Date.now(); // Record the exact start time
    room.nextPlayerIndexToPlay = 0; // Reset sound rotation index
    // Reset player 'isReady' flags (used during Hiding phase)
    Object.values(room.players).forEach(p => p.isReady = false);

    // Calculate Sound Delay based on time limit, player count, and desired plays per player
    const numPlayers = Object.keys(room.players).length;
    const playsPerPlayer = 6; // Target number of times each player's sound should play during the game
    let calculatedDelayMs = 5000; // Default delay
    if (numPlayers > 0 && playsPerPlayer > 0) {
        // Distribute total time among total plays, giving delay between each play
        calculatedDelayMs = (room.seekTimeLimit * 1000) / (numPlayers * playsPerPlayer);
    }
    // Ensure delay is at least 1 second and round it
    room.soundDelay = Math.max(1000, Math.round(calculatedDelayMs));
    console.log(`[${roomCode}] Calculated sound delay: ${room.soundDelay}ms`);

    startSeekTimer(roomCode); // Start the timer that checks for Hider win condition (time runs out)

    // Schedule the FIRST sound after an initial 10-second grace period
    console.log(`[${roomCode}] Scheduling first sound in 10 seconds.`);
    if (room.soundRotationTimeout) clearTimeout(room.soundRotationTimeout); // Clear any previous timeout
    room.soundRotationTimeout = setTimeout(() => {
        scheduleNextSound(roomCode); // Start the sound rotation logic
    }, 10000); // 10-second delay before the first sound

    broadcastUpdateState(roomCode); // Inform clients that the Seeking phase has begun
}

/**
 * Starts the main timer for the Seeking phase.
 * This timer checks every second if the time limit has been reached.
 * If time runs out, it ends the game with the Hider as the winner.
 * @param {string} roomCode - The room where the timer should start.
 */
function startSeekTimer(roomCode) {
    const room = rooms[roomCode];
    // Prevent starting multiple timers
    if (!room || room.seekTimerInterval) return;

    console.log(`[${roomCode}] Seek timer started (${room.seekTimeLimit}s).`);
    // Set up an interval to check the elapsed time every second
    room.seekTimerInterval = setInterval(() => {
        if (room.gameState === 'Seeking') {
            const elapsed = (Date.now() - room.seekStartTime) / 1000; // Calculate elapsed time in seconds
            const remaining = room.seekTimeLimit - elapsed;
            // If remaining time is zero or less, the Hider wins
            if (remaining <= 0) {
                console.log(`[${roomCode}] Time limit reached. Hider wins.`);
                endGame(roomCode, 'Hider'); // End the game
            }
        } else {
            // If the game state is no longer 'Seeking', clear this interval
             if (room.seekTimerInterval) clearInterval(room.seekTimerInterval);
             room.seekTimerInterval = null;
        }
    }, 1000);
}


/**
 * Schedules the next sound to be played during the Seeking phase.
 * Finds the next player in the rotation who hasn't been found yet,
 * tells their client to play their unique "animal" sound, and schedules the next call to this function.
 * @param {string} roomCode - The room where sounds are being played.
 */
function scheduleNextSound(roomCode) {
    const room = rooms[roomCode];
    // Stop scheduling if the room doesn't exist or the game is not in 'Seeking' state
    if (!room || room.gameState !== 'Seeking') {
        if(room && room.soundRotationTimeout) clearTimeout(room.soundRotationTimeout); // Clear any pending timeout
        if(room) room.soundRotationTimeout = null;
        console.log(`[${roomCode}] Stopping sound rotation (invalid state: ${room?.gameState}).`);
        return;
    }

    // Get players sorted by number to ensure consistent rotation order
    const sortedPlayers = Object.values(room.players).sort((a, b) => a.number - b.number);
    if (sortedPlayers.length === 0) return; // No players left

    let currentPlayerIndex = room.nextPlayerIndexToPlay % sortedPlayers.length; // Start searching from the next index
    let foundPlayerToPlay = null;
    let searchAttempts = 0; // To prevent infinite loops if all are found

    // Loop through players starting from the next index, wrapping around if needed
    while (searchAttempts < sortedPlayers.length) {
        const potentialPlayer = sortedPlayers[currentPlayerIndex];
        // If this player exists and is not yet found, they are the next to play
        if (potentialPlayer && !potentialPlayer.isFound) {
            foundPlayerToPlay = potentialPlayer;
            break; // Found a player
        }
        // Move to the next player index, wrapping around the array
        currentPlayerIndex = (currentPlayerIndex + 1) % sortedPlayers.length;
        searchAttempts++;
    }

    // If an unfound player was found and they have a sound assigned
    if (foundPlayerToPlay && foundPlayerToPlay.uniqueAnimalSoundURL) {
        console.log(`[${roomCode}] Sending playSound to Player ${foundPlayerToPlay.number} (${foundPlayerToPlay.id}) Sound: ${foundPlayerToPlay.uniqueAnimalSoundURL}`);
        // Emit 'playSound' only to the specific player's socket
        io.to(foundPlayerToPlay.id).emit('playSound', { soundURL: foundPlayerToPlay.uniqueAnimalSoundURL });

        // Update the index for the next rotation
        room.nextPlayerIndexToPlay = (currentPlayerIndex + 1);

        // Schedule the next call to this function after the calculated delay
        if (room.soundRotationTimeout) clearTimeout(room.soundRotationTimeout); // Clear previous timeout just in case
        console.log(`[${roomCode}] Scheduling next sound check in ${room.soundDelay}ms.`);
        room.soundRotationTimeout = setTimeout(() => {
            scheduleNextSound(roomCode);
        }, room.soundDelay);

    } else {
        // If no unfound players were found in the loop
        console.log(`[${roomCode}] No suitable unfound players found during sound rotation. Stopping rotation.`);
        if (room.soundRotationTimeout) clearTimeout(room.soundRotationTimeout); // Stop the rotation
        room.soundRotationTimeout = null;
        // If we searched all players and found none, it means they are all found
        if (searchAttempts >= sortedPlayers.length) {
             checkSeekerWin(roomCode); // Double-check the win condition
        }
    }
}


// --- Socket.IO Connection Handler ---
// This function runs whenever a new client connects to the server
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Room Management Events ---

    // Handle 'createRoom' event from a client
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode(); // Generate a unique code
        const playerNumber = 1; // The creator is always Player 1
        const assignedAnimalSounds = new Set(); // Track sounds used in this room
        const assignedUnfoundSounds = new Set();

        // Assign unique sounds randomly for the first player (Hider)
        let animalSoundURL = baseAnimalSounds[0]; // Default fallback
        let unfoundSoundURL = baseUnfoundSounds[0]; // Default fallback
        const availableAnimal = baseAnimalSounds.filter(s => !assignedAnimalSounds.has(s));
        if (availableAnimal.length > 0) animalSoundURL = availableAnimal[Math.floor(Math.random() * availableAnimal.length)];
        assignedAnimalSounds.add(animalSoundURL);
        const availableUnfound = baseUnfoundSounds.filter(s => !assignedUnfoundSounds.has(s));
        if (availableUnfound.length > 0) unfoundSoundURL = availableUnfound[Math.floor(Math.random() * availableUnfound.length)];
        assignedUnfoundSounds.add(unfoundSoundURL);

        // Create the room object in the 'rooms' store
        rooms[roomCode] = {
            roomCode: roomCode,
            players: {
                [socket.id]: { // Use socket ID as the key for the player
                    id: socket.id, number: playerNumber, role: 'Hider', // First player is Hider
                    isReady: false, isFound: false, // Initial states
                    uniqueAnimalSoundURL: animalSoundURL, uniqueUnfoundSoundURL: unfoundSoundURL // Assigned sounds
                }
            },
            gameState: 'Waiting', // Initial game state
            seekTimeLimit: 120, // Default time limit
            seekTimerInterval: null, seekStartTime: null, // Timer related state
            winner: null, preSeekCountdownInterval: null, preSeekCountdownValue: 10, // Countdown state
            soundRotationTimeout: null, nextPlayerIndexToPlay: 0, soundDelay: 5000, // Sound rotation state
            assignedAnimalSounds: assignedAnimalSounds, assignedUnfoundSounds: assignedUnfoundSounds, // Sets to track used sounds
            unfoundPlayerQueue: [], activeUnfoundPlayerId: null, // Game over reveal state
        };
        socket.join(roomCode); // Have the socket join the Socket.IO room
        console.log(`[${roomCode}] Room created by ${socket.id}. Player 1 (Hider) assigned Animal Sound: ${animalSoundURL}, Unfound Sound: ${unfoundSoundURL}.`);
        broadcastUpdateState(roomCode); // Send the initial state to the creator
    });

    // Handle 'joinRoom' event from a client
    socket.on('joinRoom', (roomCode) => {
        const room = rooms[roomCode];
        // Validate room existence and game state
        if (!room) { socket.emit('errorMsg', 'Room not found.'); return; }
        if (room.gameState !== 'Waiting') { socket.emit('errorMsg', 'Game has already started.'); return; }

        const playerNumber = Object.keys(room.players).length + 1; // Assign the next available player number

        // Assign unique sounds randomly with fallback if all base sounds are used
        let animalSoundURL = baseAnimalSounds[0];
        let unfoundSoundURL = baseUnfoundSounds[0];
        const availableAnimal = baseAnimalSounds.filter(s => !room.assignedAnimalSounds.has(s));
        if (availableAnimal.length > 0) animalSoundURL = availableAnimal[Math.floor(Math.random() * availableAnimal.length)];
        else animalSoundURL = baseAnimalSounds[(playerNumber - 1) % numUniqueSounds]; // Fallback: cycle through sounds
        room.assignedAnimalSounds.add(animalSoundURL); // Add to the room's used set
        const availableUnfound = baseUnfoundSounds.filter(s => !room.assignedUnfoundSounds.has(s));
        if (availableUnfound.length > 0) unfoundSoundURL = availableUnfound[Math.floor(Math.random() * availableUnfound.length)];
        else unfoundSoundURL = baseUnfoundSounds[(playerNumber - 1) % numUniqueSounds]; // Fallback: cycle through sounds
        room.assignedUnfoundSounds.add(unfoundSoundURL); // Add to the room's used set

        // Add the new player to the room's player list
        room.players[socket.id] = {
            id: socket.id, number: playerNumber, role: 'Seeker', // Joining players are Seekers
            isReady: false, isFound: false, // Initial states
            uniqueAnimalSoundURL: animalSoundURL, uniqueUnfoundSoundURL: unfoundSoundURL // Assigned sounds
        };
        socket.join(roomCode); // Have the socket join the Socket.IO room
        console.log(`[${roomCode}] ${socket.id} joined as P${playerNumber}. Assigned Animal: ${animalSoundURL}, Unfound: ${unfoundSoundURL}.`);
        broadcastUpdateState(roomCode); // Update everyone in the room with the new player list and state
    });

    // --- Game Configuration and State Changes ---

     // Handle 'configureGame' event (sent by Hider in Waiting room)
     socket.on('configureGame', (data) => {
        const roomCode = Array.from(socket.rooms)[1]; // Get room code from socket's rooms (index 0 is usually the socket's own ID room)
        const room = rooms[roomCode];
        // Validate: room exists, sender is Hider, game is in Waiting state
        if (!room || room.players[socket.id]?.role !== 'Hider' || room.gameState !== 'Waiting') return;

        const newTimeLimit = parseInt(data.seekTimeLimit, 10);
        // Validate the received time limit
        if (!isNaN(newTimeLimit) && newTimeLimit >= 15 && newTimeLimit <= 600) {
            room.seekTimeLimit = newTimeLimit;
            console.log(`[${roomCode}] Time limit updated to ${newTimeLimit}s.`);
            broadcastUpdateState(roomCode); // Inform clients of the change
        } else {
             socket.emit('errorMsg', 'Invalid time limit (must be 15-600s).'); // Send error back to Hider
        }
    });

    // Handle 'startHiding' event (sent by Hider in Waiting room)
    socket.on('startHiding', () => {
        const roomCode = Array.from(socket.rooms)[1];
        const room = rooms[roomCode];
        // Validate: room exists, sender is Hider, game is Waiting
        if (!room || room.players[socket.id]?.role !== 'Hider' || room.gameState !== 'Waiting') return;
        // Validate: enough players to start
        if (Object.keys(room.players).length < 2) { socket.emit('errorMsg', 'Need at least 2 players to start.'); return; }

        console.log(`[${roomCode}] Hider initiated Hiding phase.`);
        room.gameState = 'Hiding'; // Change game state
        // Reset player statuses for the new phase
        Object.values(room.players).forEach(p => { p.isReady = false; p.isFound = false; });
        clearGameIntervals(roomCode); // Ensure no old timers are running
        room.winner = null; room.seekStartTime = null; // Reset winner and start time
        broadcastUpdateState(roomCode); // Inform clients of the state change
    });

    // Handle 'confirmHidden' event (sent by any player during Hiding phase)
    socket.on('confirmHidden', () => {
        const roomCode = Array.from(socket.rooms)[1];
        const room = rooms[roomCode];
        const player = room?.players[socket.id];
        // Validate: room/player exist, game is Hiding, player isn't already ready
        if (!room || !player || room.gameState !== 'Hiding' || player.isReady) return;

        player.isReady = true; // Mark the player as ready (hidden)
        console.log(`[${roomCode}] Player ${player.number} confirmed hidden.`);

        // Check if all players in the room are now ready
        const allReady = Object.values(room.players).every(p => p.isReady);
        if (allReady) {
            console.log(`[${roomCode}] All players confirmed hidden. Starting pre-seek countdown.`);
            // FIX: Broadcast the final state *before* starting the countdown
            broadcastUpdateState(roomCode);
            startPreSeekCountdown(roomCode); // Start the countdown
        } else {
            // If not all ready, just broadcast the updated count
            broadcastUpdateState(roomCode);
        }
    });

    // Handle 'markSelfFound' event (sent by any player during Seeking or Game Over reveal)
    socket.on('markSelfFound', () => {
        const roomCode = Array.from(socket.rooms)[1];
        const room = rooms[roomCode];
        const player = room?.players[socket.id];
        // Validate: room/player exist, player isn't already found
        if (!room || !player || player.isFound) return;

        console.log(`[${roomCode}] Player ${player.number} marked self as found.`);
        player.isFound = true; // Mark the player as found

        // Handle the consequences based on the current game state
        if (room.gameState === 'Seeking') {
             // Check if this triggers the Seekers win condition
             const gameEnded = checkSeekerWin(roomCode);
             // If the game didn't end, broadcast the updated state
             if (!gameEnded) broadcastUpdateState(roomCode);
        } else if (room.gameState === 'GameOver' && room.winner === 'Hider') {
            // If found during the Hider win reveal phase
            console.log(`[${roomCode}] Player ${player.number} found during Hider reveal.`);
            // If the player who was found was the one actively playing sound
            if (socket.id === room.activeUnfoundPlayerId) {
                 console.log(`[${roomCode}] Active player ${player.number} found. Activating next...`);
                 activateNextUnfoundPlayer(roomCode); // Move to the next player in the reveal queue
            } else {
                 // If a different player was found (e.g., someone found theirs while another was active)
                 broadcastUpdateState(roomCode); // Just update the state
            }
        } else {
            // If found in any other state (e.g., Waiting, Hiding - shouldn't happen), just update
            broadcastUpdateState(roomCode);
        }
    });


    // Handle 'requestPlayAgain' event (sent by any player during Game Over)
    socket.on('requestPlayAgain', () => {
        const roomCode = Array.from(socket.rooms)[1];
        const room = rooms[roomCode];
        // Validate: room exists, game is GameOver
        if (!room || room.gameState !== 'GameOver') return;
        console.log(`[${roomCode}] Player ${room.players[socket.id]?.number} requested Play Again.`);

        // --- Reset Room State for a New Game ---
        room.gameState = 'Waiting'; // Back to Waiting state
        room.winner = null;
        clearGameIntervals(roomCode); // Stop all timers/loops
        room.seekStartTime = null;
        room.activeUnfoundPlayerId = null;
        room.unfoundPlayerQueue = [];
        room.nextPlayerIndexToPlay = 0;
        room.soundDelay = 5000; // Reset sound delay
        room.assignedAnimalSounds = new Set(); // Clear used sound sets
        room.assignedUnfoundSounds = new Set();

        // Reset player statuses and re-assign sounds randomly
        Object.values(room.players).forEach(p => {
            p.isReady = false; // Reset ready status
            p.isFound = false; // Reset found status

            // Re-assign sounds similar to how it's done in join/create
            let animalSoundURL = baseAnimalSounds[0];
            let unfoundSoundURL = baseUnfoundSounds[0];
            const availableAnimal = baseAnimalSounds.filter(s => !room.assignedAnimalSounds.has(s));
            if (availableAnimal.length > 0) animalSoundURL = availableAnimal[Math.floor(Math.random() * availableAnimal.length)];
            else animalSoundURL = baseAnimalSounds[(p.number - 1) % numUniqueSounds];
            room.assignedAnimalSounds.add(animalSoundURL);
            const availableUnfound = baseUnfoundSounds.filter(s => !room.assignedUnfoundSounds.has(s));
             if (availableUnfound.length > 0) unfoundSoundURL = availableUnfound[Math.floor(Math.random() * availableUnfound.length)];
             else unfoundSoundURL = baseUnfoundSounds[(p.number - 1) % numUniqueSounds];
             room.assignedUnfoundSounds.add(unfoundSoundURL);
             p.uniqueAnimalSoundURL = animalSoundURL; // Update player's assigned sound
             p.uniqueUnfoundSoundURL = unfoundSoundURL; // Update player's assigned sound
             console.log(`[${roomCode}] Re-assigned sounds for P${p.number}. Animal: ${animalSoundURL}, Unfound: ${unfoundSoundURL}.`);
        });

        broadcastUpdateState(roomCode); // Inform all clients about the reset state and new sounds
    });


    // --- Disconnection Handling ---
    // Handle the 'disconnect' event (automatically triggered by Socket.IO)
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        let roomCode = null;
        let playerNumber = null;
        let wasHider = false;
        let wasActiveUnfound = false; // Was this player the one playing sound in reveal?
        let wasInSeeking = false;
        let wasInHiding = false;
        let disconnectedPlayerSoundAnimal = null;
        let disconnectedPlayerSoundUnfound = null;

        // Find the room the disconnected player was in
        for (const rc in rooms) {
            if (rooms[rc].players[socket.id]) {
                roomCode = rc;
                const room = rooms[rc];
                const player = room.players[socket.id];

                // Store info about the disconnected player before removing them
                playerNumber = player.number;
                wasHider = player.role === 'Hider';
                wasActiveUnfound = socket.id === room.activeUnfoundPlayerId;
                wasInSeeking = room.gameState === 'Seeking';
                wasInHiding = room.gameState === 'Hiding';
                disconnectedPlayerSoundAnimal = player.uniqueAnimalSoundURL;
                disconnectedPlayerSoundUnfound = player.uniqueUnfoundSoundURL;

                console.log(`[${roomCode}] Player ${playerNumber} (${socket.id}, ${player.role}) disconnected.`);
                // Remove the player from the room state
                delete room.players[socket.id];

                // Remove the player's sounds from the assigned sets so they can be reused
                if (disconnectedPlayerSoundAnimal) room.assignedAnimalSounds?.delete(disconnectedPlayerSoundAnimal);
                if (disconnectedPlayerSoundUnfound) room.assignedUnfoundSounds?.delete(disconnectedPlayerSoundUnfound);

                // --- Handle Room/Game State Adjustments ---

                // If the room is now empty, delete the room
                if (Object.keys(room.players).length === 0) {
                    console.log(`[${roomCode}] Room empty, deleting.`);
                     clearGameIntervals(roomCode); // Clean up intervals
                     delete rooms[roomCode]; // Remove room from memory
                     return; // Stop further processing for this disconnect
                }

                // If the game was in the Waiting state
                if (room.gameState === 'Waiting') {
                    // If the Hider disconnected, promote the next player (lowest number) to Hider
                    if (wasHider) {
                        const remaining = Object.values(room.players).sort((a,b) => a.number - b.number);
                        if (remaining.length > 0) {
                            remaining[0].role = 'Hider'; // Promote the first remaining player
                            console.log(`[${roomCode}] P${remaining[0].number} promoted to Hider.`);
                        }
                    }
                    // Renumber players? (Optional, could add complexity)
                    broadcastUpdateState(roomCode); // Update clients
                }
                // If the game was in the Hiding state
                else if (wasInHiding) {
                    // Check if all *remaining* players are now ready
                    const allRemainingReady = Object.values(room.players).every(p => p.isReady);
                    // If they are, and there are still players left, and countdown isn't running, start it
                    if (allRemainingReady && Object.keys(room.players).length > 0 && !room.preSeekCountdownInterval) {
                        startPreSeekCountdown(roomCode);
                    } else { broadcastUpdateState(roomCode); } // Otherwise, just update state
                }
                // If the game was in the Seeking state
                else if (wasInSeeking) {
                    // If the Hider disconnected, the Seekers instantly win
                    if (wasHider) {
                        console.log(`[${roomCode}] Hider disconnected during Seeking. Seekers win.`);
                        endGame(roomCode, 'Seekers');
                    } else {
                        // If a Seeker disconnected, check if this makes the Seekers win
                        if (!checkSeekerWin(roomCode)) {
                            // If game continues, just update state
                            broadcastUpdateState(roomCode);
                        }
                    }
                }
                // If the game was in the Game Over state (Hider win reveal)
                else if (room.gameState === 'GameOver' && room.winner === 'Hider') {
                     // Remove the disconnected player from the reveal queue if they were in it
                     const queueIndex = room.unfoundPlayerQueue.indexOf(socket.id);
                     if (queueIndex > -1) room.unfoundPlayerQueue.splice(queueIndex, 1);
                     // If the disconnected player was the one actively playing sound
                     if (wasActiveUnfound) {
                         activateNextUnfoundPlayer(roomCode); // Activate the next player
                     } else {
                         broadcastUpdateState(roomCode); // Otherwise, just update state
                     }
                } else {
                    // For any other state, just broadcast the update
                    broadcastUpdateState(roomCode);
                }
                break; // Exit the loop once the player's room is found and handled
            }
        }
    });
});

// --- Server Start ---
// Start the HTTP server and listen on the defined port
server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});
