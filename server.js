/**
 * server.js (Refactored)
 *
 * Main server file for the Hide 'n' Seek web application.
 * Handles game logic, room management, and WebSocket communication using Socket.IO.
 * Refactored for better structure, maintainability, and clarity.
 */

// --- Core Modules ---
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// =============================================================================
// == Constants & Configuration
// =============================================================================

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public'); // Serve static files from here
const ROOM_CODE_LENGTH = 5;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MIN_PLAYERS_TO_START = 2;

// Game Timing & Settings Defaults
const DEFAULT_SEEK_TIME_LIMIT_S = 120;
const MIN_SEEK_TIME_LIMIT_S = 15;
const MAX_SEEK_TIME_LIMIT_S = 600;
const DEFAULT_SOUND_PLAYS_PER_PLAYER = 6;
const MIN_SOUND_PLAYS = 1;
const MAX_SOUND_PLAYS = 20; // Increased limit
const PRE_SEEK_COUNTDOWN_S = 10;
const MIN_SOUND_DELAY_MS = 1000; // Minimum delay between any two sounds scheduled
const CHECK_INTERVAL_WHEN_NO_SOUNDS_MS = 1500; // How often to check game state if no sounds are eligible

// Game States
const GAME_STATE = Object.freeze({
    WAITING: 'Waiting',
    HIDING: 'Hiding',
    SEEKING: 'Seeking',
    GAME_OVER: 'GameOver',
});

// Player Roles
const PLAYER_ROLE = Object.freeze({
    HIDER: 'Hider',
    SEEKER: 'Seeker',
});

// Winner Types
const WINNER_TYPE = Object.freeze({
    HIDER: 'Hider',
    SEEKERS: 'Seekers',
});

// Sound Files (Ensure these exist in the public/sounds directory)
// NOTE: It's crucial that baseAnimalSounds and baseUnfoundSounds have the same number of elements.
const BASE_ANIMAL_SOUNDS = [
    '/sounds/cat.mp3', '/sounds/chicken.mp3', '/sounds/cow.mp3', '/sounds/dog.mp3',
    '/sounds/donkey.mp3', '/sounds/horse.mp3', '/sounds/sheep.mp3', '/sounds/bird.mp3'
];
const BASE_UNFOUND_SOUNDS = [
    '/sounds/unfound1.mp3', '/sounds/unfound2.mp3', '/sounds/unfound3.mp3', '/sounds/unfound4.mp3',
    '/sounds/unfound5.mp3', '/sounds/unfound6.mp3', '/sounds/unfound7.mp3', '/sounds/unfound8.mp3'
];

// Validate sound configuration on startup
if (BASE_ANIMAL_SOUNDS.length !== BASE_UNFOUND_SOUNDS.length) {
    console.warn("Configuration Warning: The number of animal sounds does not match the number of unfound sounds. Please ensure corresponding sounds exist.");
}
const NUM_UNIQUE_SOUND_PAIRS = Math.min(BASE_ANIMAL_SOUNDS.length, BASE_UNFOUND_SOUNDS.length);
if (NUM_UNIQUE_SOUND_PAIRS === 0) {
    console.error("CRITICAL ERROR: No sound pairs defined in BASE_ANIMAL_SOUNDS/BASE_UNFOUND_SOUNDS. Sound assignment will fail.");
    // Consider exiting the process if sounds are critical
    // process.exit(1);
} else if (NUM_UNIQUE_SOUND_PAIRS < 8) { // Example threshold
    console.warn(`Warning: Only ${NUM_UNIQUE_SOUND_PAIRS} unique sound pairs available. Consider adding more sound files.`);
}

// =============================================================================
// == Global State
// =============================================================================

// Stores all active game rooms and their states. Key: roomCode, Value: Room instance
const activeRooms = {};

// =============================================================================
// == Utility Functions
// =============================================================================

/**
 * Generates a unique room code not currently present in activeRooms.
 * @returns {string} A unique room code.
 */
function generateUniqueRoomCode() {
    let code;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loop in unlikely scenario
    do {
        if (attempts++ > maxAttempts) {
            throw new Error("Failed to generate a unique room code after multiple attempts.");
        }
        code = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
            code += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length));
        }
    } while (activeRooms[code]); // Ensure uniqueness
    return code;
}

// =============================================================================
// == Player Class
// =============================================================================
class Player {
    constructor(id, number, role) {
        this.id = id;
        this.number = number;
        this.role = role;
        this.isReady = false; // Ready state for Hiding phase
        this.isFound = false; // Found state for Seeking/Game Over phases
        this.soundsPlayed = 0; // Sounds played count during Seeking phase
        this.uniqueAnimalSoundURL = null;
        this.uniqueUnfoundSoundURL = null;
    }

    /** Resets player state for a new game or phase transition. */
    resetForNewGame() {
        this.isReady = false;
        this.isFound = false;
        this.soundsPlayed = 0;
        // Role and sounds are reassigned by the Room class
    }

    /** Resets player state specifically for the start of the seeking phase. */
    resetForSeeking() {
        this.isReady = false; // Clear ready status from hiding phase
        this.soundsPlayed = 0; // Reset sounds played count
    }

    /** Returns a simplified player object safe for client transmission. */
    getClientState() {
        return {
            id: this.id,
            number: this.number,
            role: this.role,
            isReady: this.isReady,
            isFound: this.isFound,
            uniqueAnimalSoundURL: this.uniqueAnimalSoundURL,
            uniqueUnfoundSoundURL: this.uniqueUnfoundSoundURL,
            // Note: soundsPlayed is intentionally omitted from client state
        };
    }
}

// =============================================================================
// == Room Class
// =============================================================================
class Room {
    constructor(roomCode, ioInstance) {
        this.roomCode = roomCode;
        this.io = ioInstance; // Store io instance for broadcasting within the room
        this.players = {}; // Key: socket.id, Value: Player instance
        this.gameState = GAME_STATE.WAITING;
        this.seekTimeLimit = DEFAULT_SEEK_TIME_LIMIT_S;
        this.soundPlaysPerPlayer = DEFAULT_SOUND_PLAYS_PER_PLAYER;
        this.seekTimerInterval = null;
        this.seekStartTime = null;
        this.winner = null;
        this.preSeekCountdownInterval = null;
        this.preSeekCountdownValue = PRE_SEEK_COUNTDOWN_S;
        this.soundRotationTimeout = null;
        this.nextPlayerIndexToPlay = 0; // Index for round-robin sound rotation among eligible players
        this.assignedAnimalSounds = new Set(); // Track used sounds in this room
        this.assignedUnfoundSounds = new Set();
        this.unfoundPlayerQueue = []; // For Hider win reveal sequence
        this.activeUnfoundPlayerId = null; // Tracks who is playing sound in reveal
    }

    // --- Player Management ---

    addPlayer(socket) {
        if (this.gameState !== GAME_STATE.WAITING) {
            throw new Error("Cannot join room: Game has already started.");
        }
        if (this.players[socket.id]) {
             throw new Error("Cannot join room: You are already in this room.");
        }

        const playerNumber = Object.keys(this.players).length + 1;
        const role = (playerNumber === 1) ? PLAYER_ROLE.HIDER : PLAYER_ROLE.SEEKER;
        const newPlayer = new Player(socket.id, playerNumber, role);

        this._assignUniqueSounds(newPlayer); // Assign sounds internally
        this.players[socket.id] = newPlayer;
        socket.join(this.roomCode);

        console.log(`[${this.roomCode}] P${playerNumber} (${socket.id}, ${role}) joined. Sounds: A=${newPlayer.uniqueAnimalSoundURL}, U=${newPlayer.uniqueUnfoundSoundURL}`);
        this.broadcastUpdateState();
        return newPlayer;
    }

    removePlayer(socketId) {
        const disconnectedPlayer = this.players[socketId];
        if (!disconnectedPlayer) return false; // Player wasn't in this room

        console.log(`[${this.roomCode}] P${disconnectedPlayer.number} (${socketId}, ${disconnectedPlayer.role}) disconnected/left.`);

        // Store info before removing
        const wasHider = disconnectedPlayer.role === PLAYER_ROLE.HIDER;
        const wasActiveUnfound = socketId === this.activeUnfoundPlayerId;
        const wasInSeeking = this.gameState === GAME_STATE.SEEKING;
        const wasInHiding = this.gameState === GAME_STATE.HIDING;
        const wasInGameOverReveal = this.gameState === GAME_STATE.GAME_OVER && this.winner === WINNER_TYPE.HIDER;

        // Make player's sounds available again
        if (disconnectedPlayer.uniqueAnimalSoundURL) this.assignedAnimalSounds.delete(disconnectedPlayer.uniqueAnimalSoundURL);
        if (disconnectedPlayer.uniqueUnfoundSoundURL) this.assignedUnfoundSounds.delete(disconnectedPlayer.uniqueUnfoundSoundURL);

        // Remove player from room state
        delete this.players[socketId];

        // --- Adjust Game/Room State ---

        // If room is now empty, signal for deletion
        if (this.isEmpty()) {
            console.log(`[${this.roomCode}] Room empty after disconnect.`);
            this.clearGameIntervals(); // Clean up intervals before deletion
            return true; // Indicate room should be deleted
        }

        // Handle state adjustments based on when the player left
        if (this.gameState === GAME_STATE.WAITING) {
            if (wasHider) this._promoteNewHider();
            this.broadcastUpdateState();
        } else if (wasInHiding) {
            if (this._checkAllRemainingReady() && !this.preSeekCountdownInterval) {
                console.log(`[${this.roomCode}] Disconnect during Hiding triggered readiness. Starting countdown.`);
                this.startPreSeekCountdown();
            } else {
                this.broadcastUpdateState();
            }
        } else if (wasInSeeking) {
            if (wasHider) {
                console.log(`[${this.roomCode}] Hider disconnected during Seeking. Seekers win.`);
                this.endGame(WINNER_TYPE.SEEKERS);
            } else {
                // If a Seeker disconnected, check win condition again
                if (!this.checkSeekerWin()) {
                    this.broadcastUpdateState(); // Game continues, just update state
                }
            }
        } else if (wasInGameOverReveal) {
            // Remove player from reveal queue if they were in it
            const queueIndex = this.unfoundPlayerQueue.indexOf(socketId);
            if (queueIndex > -1) this.unfoundPlayerQueue.splice(queueIndex, 1);

            if (wasActiveUnfound) {
                console.log(`[${this.roomCode}] Active reveal player disconnected. Activating next...`);
                this.activateNextUnfoundPlayer();
            } else {
                this.broadcastUpdateState();
            }
        } else {
            // For other states (e.g., GameOver Seekers Win), just update
            this.broadcastUpdateState();
        }
        return false; // Indicate room should not be deleted
    }

    isEmpty() {
        return Object.keys(this.players).length === 0;
    }

    getPlayer(socketId) {
        return this.players[socketId];
    }

    getPlayerCount() {
        return Object.keys(this.players).length;
    }

    _promoteNewHider() {
        const remainingPlayers = Object.values(this.players).sort((a, b) => a.number - b.number);
        if (remainingPlayers.length > 0) {
            remainingPlayers[0].role = PLAYER_ROLE.HIDER;
            console.log(`[${this.roomCode}] P${remainingPlayers[0].number} (${remainingPlayers[0].id}) promoted to Hider.`);
            // Note: Player numbers are not reassigned for simplicity
        }
    }

    // --- Sound Assignment ---

    _assignUniqueSounds(player) {
        let animalSoundURL = BASE_ANIMAL_SOUNDS[0] || null;
        let unfoundSoundURL = BASE_UNFOUND_SOUNDS[0] || null;

        if (NUM_UNIQUE_SOUND_PAIRS > 0) {
            const availableAnimal = BASE_ANIMAL_SOUNDS.filter(s => !this.assignedAnimalSounds.has(s));
            if (availableAnimal.length > 0) {
                animalSoundURL = availableAnimal[Math.floor(Math.random() * availableAnimal.length)];
            } else {
                animalSoundURL = BASE_ANIMAL_SOUNDS[(player.number - 1) % NUM_UNIQUE_SOUND_PAIRS];
                console.warn(`[${this.roomCode}] Ran out of unique animal sounds, assigning fallback: ${animalSoundURL}`);
            }
            this.assignedAnimalSounds.add(animalSoundURL);

            const availableUnfound = BASE_UNFOUND_SOUNDS.filter(s => !this.assignedUnfoundSounds.has(s));
            if (availableUnfound.length > 0) {
                unfoundSoundURL = availableUnfound[Math.floor(Math.random() * availableUnfound.length)];
            } else {
                unfoundSoundURL = BASE_UNFOUND_SOUNDS[(player.number - 1) % NUM_UNIQUE_SOUND_PAIRS];
                console.warn(`[${this.roomCode}] Ran out of unique unfound sounds, assigning fallback: ${unfoundSoundURL}`);
            }
            this.assignedUnfoundSounds.add(unfoundSoundURL);
        } else {
             console.error(`[${this.roomCode}] No sound pairs defined or available! Assigning null.`);
             animalSoundURL = null;
             unfoundSoundURL = null;
        }
        player.uniqueAnimalSoundURL = animalSoundURL;
        player.uniqueUnfoundSoundURL = unfoundSoundURL;
    }

    // --- Game State & Logic ---

    updateSettings(settings) {
        let updated = false;
        // Validate and update Time Limit
        const newTimeLimit = parseInt(settings?.seekTimeLimit, 10);
        if (!isNaN(newTimeLimit) && newTimeLimit >= MIN_SEEK_TIME_LIMIT_S && newTimeLimit <= MAX_SEEK_TIME_LIMIT_S) {
            if (this.seekTimeLimit !== newTimeLimit) {
                this.seekTimeLimit = newTimeLimit;
                console.log(`[${this.roomCode}] Time limit updated to ${newTimeLimit}s.`);
                updated = true;
            }
        } else if (settings?.seekTimeLimit !== undefined) {
            throw new Error(`Invalid time limit. Must be between ${MIN_SEEK_TIME_LIMIT_S} and ${MAX_SEEK_TIME_LIMIT_S} seconds.`);
        }

        // Validate and update Sound Plays per Player
        const newSoundPlays = parseInt(settings?.soundPlaysPerPlayer, 10);
        if (!isNaN(newSoundPlays) && newSoundPlays >= MIN_SOUND_PLAYS && newSoundPlays <= MAX_SOUND_PLAYS) {
            if (this.soundPlaysPerPlayer !== newSoundPlays) {
                this.soundPlaysPerPlayer = newSoundPlays;
                console.log(`[${this.roomCode}] Sound plays per player updated to ${newSoundPlays}.`);
                updated = true;
            }
        } else if (settings?.soundPlaysPerPlayer !== undefined) {
            throw new Error(`Invalid sounds per phone. Must be between ${MIN_SOUND_PLAYS} and ${MAX_SOUND_PLAYS}.`);
        }

        if (updated) {
            this.broadcastUpdateState();
        }
    }

    startHidingPhase() {
        if (this.gameState !== GAME_STATE.WAITING) throw new Error("Game is not in Waiting state.");
        if (this.getPlayerCount() < MIN_PLAYERS_TO_START) throw new Error(`Need at least ${MIN_PLAYERS_TO_START} players to start.`);

        console.log(`[${this.roomCode}] Initiating Hiding phase.`);
        this.gameState = GAME_STATE.HIDING;
        Object.values(this.players).forEach(p => p.resetForNewGame()); // Reset ready/found/soundsPlayed
        this.clearGameIntervals(); // Ensure no old timers
        this.winner = null;
        this.seekStartTime = null;
        this.broadcastUpdateState();
    }

    confirmPlayerHidden(socketId) {
        const player = this.getPlayer(socketId);
        if (!player) throw new Error("Player not found in room.");
        if (this.gameState !== GAME_STATE.HIDING) throw new Error("Not in Hiding phase.");
        if (player.isReady) return; // Already confirmed

        player.isReady = true;
        console.log(`[${this.roomCode}] P${player.number} (${socketId}) confirmed hidden.`);

        if (this._checkAllRemainingReady()) {
            console.log(`[${this.roomCode}] All players confirmed hidden. Starting pre-seek countdown.`);
            this.broadcastUpdateState(); // Broadcast final hiding state before countdown
            this.startPreSeekCountdown();
        } else {
            this.broadcastUpdateState(); // Update ready count
        }
    }

    _checkAllRemainingReady() {
        if (this.isEmpty()) return false; // Cannot be ready if empty
        return Object.values(this.players).every(p => p.isReady);
    }

    startPreSeekCountdown() {
        if (this.preSeekCountdownInterval) return; // Already running

        console.log(`[${this.roomCode}] Starting pre-seek countdown.`);
        this.preSeekCountdownValue = PRE_SEEK_COUNTDOWN_S;
        this.io.to(this.roomCode).emit('preSeekCountdown', this.preSeekCountdownValue); // Emit initial value

        this.preSeekCountdownInterval = setInterval(() => {
            // Interval checks itself if room still exists via `activeRooms` lookup
            const currentRoom = activeRooms[this.roomCode];
            if (!currentRoom || currentRoom !== this) { // Ensure interval belongs to the correct, existing room instance
                if(this.preSeekCountdownInterval) clearInterval(this.preSeekCountdownInterval);
                this.preSeekCountdownInterval = null;
                console.warn(`[${this.roomCode}] Stale preSeekCountdownInterval cleared.`);
                return;
            }

            this.preSeekCountdownValue--;
            this.io.to(this.roomCode).emit('preSeekCountdown', this.preSeekCountdownValue);

            if (this.preSeekCountdownValue <= 0) {
                clearInterval(this.preSeekCountdownInterval);
                this.preSeekCountdownInterval = null;
                this.startSeekingPhase(); // Transition to Seeking phase
            }
        }, 1000);
    }

    startSeekingPhase() {
        if (this.gameState === GAME_STATE.SEEKING) return; // Prevent multiple starts

        console.log(`[${this.roomCode}] Starting Seeking Phase.`);
        this.gameState = GAME_STATE.SEEKING;
        this.seekStartTime = Date.now();
        this.nextPlayerIndexToPlay = 0; // Reset sound rotation index

        Object.values(this.players).forEach(p => p.resetForSeeking()); // Reset ready/soundsPlayed

        this.startSeekTimer(); // Start the end-game timer

        // Schedule the first sound check
        console.log(`[${this.roomCode}] Scheduling first sound check.`);
        if (this.soundRotationTimeout) clearTimeout(this.soundRotationTimeout);
        this.soundRotationTimeout = setTimeout(() => {
            this.scheduleNextSound();
        }, MIN_SOUND_DELAY_MS);

        this.broadcastUpdateState();
    }

    startSeekTimer() {
        if (this.seekTimerInterval) return; // Already running

        console.log(`[${this.roomCode}] Seek timer started (${this.seekTimeLimit}s).`);
        this.seekTimerInterval = setInterval(() => {
            // Interval checks itself if room still exists via `activeRooms` lookup
            const currentRoom = activeRooms[this.roomCode];
             if (!currentRoom || currentRoom !== this) {
                 if(this.seekTimerInterval) clearInterval(this.seekTimerInterval);
                 this.seekTimerInterval = null;
                 console.warn(`[${this.roomCode}] Stale seekTimerInterval cleared.`);
                 return;
             }

            if (this.gameState === GAME_STATE.SEEKING) {
                const elapsedSeconds = (Date.now() - this.seekStartTime) / 1000;
                if (elapsedSeconds >= this.seekTimeLimit) {
                    console.log(`[${this.roomCode}] Time limit reached. Hider wins.`);
                    this.endGame(WINNER_TYPE.HIDER);
                    // endGame clears the interval
                }
            } else {
                // If game state changed, clear this interval
                clearInterval(this.seekTimerInterval);
                this.seekTimerInterval = null;
            }
        }, 1000); // Check every second
    }

    scheduleNextSound() {
        // Stop scheduling if game not Seeking
        if (this.gameState !== GAME_STATE.SEEKING) {
            if (this.soundRotationTimeout) clearTimeout(this.soundRotationTimeout);
            this.soundRotationTimeout = null;
            return;
        }

        const timeElapsedMs = Date.now() - this.seekStartTime;
        const timeRemainingMs = Math.max(0, (this.seekTimeLimit * 1000) - timeElapsedMs);

        if (timeRemainingMs <= 0) {
             console.log(`[${this.roomCode}] Time remaining is zero or less in scheduleNextSound. Stopping sound schedule.`);
             if (this.soundRotationTimeout) clearTimeout(this.soundRotationTimeout);
             this.soundRotationTimeout = null;
            return; // Time is up, timer will handle game end
        }

        const sortedPlayers = Object.values(this.players).sort((a, b) => a.number - b.number);
        const eligiblePlayers = sortedPlayers.filter(p => !p.isFound && p.soundsPlayed < this.soundPlaysPerPlayer);

        let dynamicDelayMs = CHECK_INTERVAL_WHEN_NO_SOUNDS_MS;
        let playerToPlay = null;

        if (eligiblePlayers.length > 0) {
            const totalPlaysLeft = eligiblePlayers.reduce((sum, p) => sum + (this.soundPlaysPerPlayer - p.soundsPlayed), 0);

            if (totalPlaysLeft > 0) {
                dynamicDelayMs = Math.max(MIN_SOUND_DELAY_MS, timeRemainingMs / totalPlaysLeft);

                // Select player using rotation index
                const nextEligiblePlayerIndex = this.nextPlayerIndexToPlay % eligiblePlayers.length;
                playerToPlay = eligiblePlayers[nextEligiblePlayerIndex];
                this.nextPlayerIndexToPlay = (nextEligiblePlayerIndex + 1); // Increment for next time

                // Emit sound to the selected player
                if (playerToPlay && playerToPlay.uniqueAnimalSoundURL) {
                    this.io.to(playerToPlay.id).emit('playSound', { soundURL: playerToPlay.uniqueAnimalSoundURL });
                    playerToPlay.soundsPlayed++;
                     console.log(`[${this.roomCode}] Sound play ${playerToPlay.soundsPlayed}/${this.soundPlaysPerPlayer} triggered for P${playerToPlay.number}. Next check in ${dynamicDelayMs.toFixed(0)}ms.`);
                } else {
                     console.warn(`[${this.roomCode}] Eligible player P${playerToPlay?.number} found but has no sound URL. Skipping play.`);
                     playerToPlay = null; // Ensure no sound is counted if URL missing
                }
            } else {
                 console.warn(`[${this.roomCode}] Eligible players found, but totalPlaysLeft is 0. Using default check interval.`);
            }
        } else {
            // console.log(`[${this.roomCode}] No eligible players found for sound rotation this cycle. Next check in ${dynamicDelayMs}ms.`); // Verbose
        }

        // Schedule the next check
        if (this.soundRotationTimeout) clearTimeout(this.soundRotationTimeout);
        this.soundRotationTimeout = setTimeout(() => {
            // Check room still exists before recursive call
            if (activeRooms[this.roomCode] === this) {
                this.scheduleNextSound();
            } else {
                 console.warn(`[${this.roomCode}] Room instance changed or deleted before next sound schedule.`);
            }
        }, dynamicDelayMs);
    }


    markPlayerFound(socketId) {
        const player = this.getPlayer(socketId);
        if (!player) throw new Error("Player not found.");
        if (player.isFound) return; // Already found

        // Allow marking found during Seeking OR during Game Over reveal
         if (this.gameState !== GAME_STATE.SEEKING && !(this.gameState === GAME_STATE.GAME_OVER && this.winner === WINNER_TYPE.HIDER)) {
             throw new Error(`Cannot mark found in current game state: ${this.gameState}`);
         }

        console.log(`[${this.roomCode}] P${player.number} (${socketId}) marked self as found.`);
        player.isFound = true;

        if (this.gameState === GAME_STATE.SEEKING) {
            if (!this.checkSeekerWin()) { // checkSeekerWin calls endGame if true
                this.broadcastUpdateState(); // Game continues, update state
            }
        } else if (this.gameState === GAME_STATE.GAME_OVER) { // Must be Hider Win Reveal
             console.log(`[${this.roomCode}] P${player.number} found during Hider reveal.`);
            if (socketId === this.activeUnfoundPlayerId) {
                console.log(`[${this.roomCode}] Active reveal player ${player.number} found. Activating next...`);
                this.activateNextUnfoundPlayer(); // Move to next in queue
            } else {
                 // Remove from queue if found out of order
                 const queueIndex = this.unfoundPlayerQueue.indexOf(socketId);
                 if (queueIndex > -1) this.unfoundPlayerQueue.splice(queueIndex, 1);
                this.broadcastUpdateState(); // Update list render
            }
        }
    }

    checkSeekerWin() {
        if (this.gameState !== GAME_STATE.SEEKING) return false;

        const allFound = Object.values(this.players).every(p => p.isFound);
        if (allFound) {
            console.log(`[${this.roomCode}] Seeker win condition met.`);
            this.endGame(WINNER_TYPE.SEEKERS);
            return true;
        }
        return false;
    }

    endGame(winner) {
        if (this.gameState === GAME_STATE.GAME_OVER) return; // Already ended

        console.log(`[${this.roomCode}] Game Over. Winner: ${winner}`);
        this.clearGameIntervals(); // Stop all active timers/loops

        this.gameState = GAME_STATE.GAME_OVER;
        this.winner = winner;

        if (winner === WINNER_TYPE.HIDER) {
            this.startGameOverReveal();
        } else if (winner === WINNER_TYPE.SEEKERS) {
            this.io.to(this.roomCode).emit('playVictoryMelody');
            this.broadcastUpdateState(); // Send final state immediately
        } else {
            this.broadcastUpdateState(); // Should not happen
        }
    }

    startGameOverReveal() {
        if (this.winner !== WINNER_TYPE.HIDER) return;

        this.unfoundPlayerQueue = Object.values(this.players)
            .filter(p => !p.isFound)
            .sort((a, b) => a.number - b.number)
            .map(p => p.id);

        console.log(`[${this.roomCode}] Starting Hider Win reveal. Queue:`, this.unfoundPlayerQueue);
        this.activateNextUnfoundPlayer();
    }

    activateNextUnfoundPlayer() {
        if (this.gameState !== GAME_STATE.GAME_OVER) return; // Only run during game over

        this.activeUnfoundPlayerId = null; // Reset active player

        if (this.unfoundPlayerQueue.length === 0) {
            console.log(`[${this.roomCode}] Reveal queue empty. Reveal finished.`);
            this.broadcastUpdateState(); // Update state one last time
            return;
        }

        const nextPlayerId = this.unfoundPlayerQueue.shift(); // Get next ID
        this.activeUnfoundPlayerId = nextPlayerId;

        const player = this.players[nextPlayerId];
        if (player && player.uniqueUnfoundSoundURL) {
            this.io.to(nextPlayerId).emit('becomeActiveUnfound', { soundURL: player.uniqueUnfoundSoundURL });
            console.log(`[${this.roomCode}] Activating P${player.number} (${nextPlayerId}) for reveal. Sound: ${player.uniqueUnfoundSoundURL}.`);
        } else {
            console.warn(`[${this.roomCode}] Player ${nextPlayerId} or their unfound sound not found during reveal activation. Skipping.`);
            this.activateNextUnfoundPlayer(); // Immediately try the next player
            return; // Avoid broadcasting state for the skipped player
        }

        this.broadcastUpdateState(); // Update all clients with the new active player
    }


    requestPlayAgain(socketId) {
         if (this.gameState !== GAME_STATE.GAME_OVER) throw new Error("Game is not over yet.");
         const player = this.getPlayer(socketId);
         if (!player) throw new Error("Player not found.");

         console.log(`[${this.roomCode}] P${player.number} (${socketId}) requested Play Again.`);
         this.resetForNewGame();
    }

    resetForNewGame() {
        console.log(`[${this.roomCode}] Resetting room for new game.`);
        this.gameState = GAME_STATE.WAITING;
        this.winner = null;
        this.clearGameIntervals();
        this.seekStartTime = null;
        this.activeUnfoundPlayerId = null;
        this.unfoundPlayerQueue = [];
        this.assignedAnimalSounds.clear();
        this.assignedUnfoundSounds.clear();

        // Reset player states and re-assign sounds
        Object.values(this.players).forEach(p => {
            p.resetForNewGame();
            this._assignUniqueSounds(p); // Reassign sounds
        });

        // Hider role remains the same

        this.broadcastUpdateState();
    }


    // --- Utility & State Management ---

    clearGameIntervals() {
        if (this.preSeekCountdownInterval) clearInterval(this.preSeekCountdownInterval);
        if (this.seekTimerInterval) clearInterval(this.seekTimerInterval);
        if (this.soundRotationTimeout) clearTimeout(this.soundRotationTimeout);

        this.preSeekCountdownInterval = null;
        this.seekTimerInterval = null;
        this.soundRotationTimeout = null;
        this.nextPlayerIndexToPlay = 0; // Reset sound index as well

        console.log(`[${this.roomCode}] Cleared game intervals and sound schedule state.`);
    }

    getClientState() {
        const playersForClient = {};
        Object.values(this.players).forEach(p => {
            playersForClient[p.id] = p.getClientState();
        });

        return {
            roomCode: this.roomCode,
            players: playersForClient,
            gameState: this.gameState,
            seekTimeLimit: this.seekTimeLimit,
            soundPlaysPerPlayer: this.soundPlaysPerPlayer, // Include this setting
            seekStartTime: this.seekStartTime,
            winner: this.winner,
            activeUnfoundPlayerId: this.activeUnfoundPlayerId,
        };
    }

    broadcastUpdateState() {
        const state = this.getClientState();
        if (state) {
            this.io.to(this.roomCode).emit('updateState', state);
        } else {
            console.warn(`[${this.roomCode}] Attempted to broadcast state but failed to get client state.`);
        }
    }
}


// =============================================================================
// == Server Setup & Socket Handlers
// =============================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(PUBLIC_DIR));

// Main Socket.IO connection handler
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Room Management Handlers ---

    socket.on('createRoom', () => {
        try {
            const roomCode = generateUniqueRoomCode();
            const newRoom = new Room(roomCode, io); // Pass io instance
            activeRooms[roomCode] = newRoom;
            newRoom.addPlayer(socket); // addPlayer handles joining and broadcasting
        } catch (error) {
            console.error(`[${socket.id}] Error creating room:`, error);
            socket.emit('errorMsg', error.message || 'Failed to create room. Please try again.');
        }
    });

    socket.on('joinRoom', (roomCode) => {
        try {
            const room = activeRooms[roomCode];
            if (!room) {
                return socket.emit('errorMsg', 'Room not found.');
            }
            room.addPlayer(socket); // addPlayer handles validation, joining, broadcasting
        } catch (error) {
            console.error(`[${socket.id}] Error joining room ${roomCode}:`, error);
            socket.emit('errorMsg', error.message || 'Failed to join room. Please try again.');
        }
    });

     socket.on('leaveRoom', () => {
        const room = findRoomBySocketId(socket.id);
        if (room) {
            console.log(`[${room.roomCode}] ${socket.id} requested to leave.`);
            socket.leave(room.roomCode); // Leave the Socket.IO room
            // Trigger the disconnect logic manually
            handleDisconnect(socket);
        } else {
            console.warn(`[${socket.id}] Tried to leave but was not in a recognized room.`);
        }
    });

    // --- Game Action Handlers ---

    socket.on('updateSettings', (settings) => {
        const room = findRoomBySocketId(socket.id);
        try {
            if (!room) throw new Error("Not currently in a room.");
            const player = room.getPlayer(socket.id);
            if (!player) throw new Error("Player not found in room."); // Should not happen if room found
            if (player.role !== PLAYER_ROLE.HIDER) throw new Error("Only the Hider can change settings.");
            if (room.gameState !== GAME_STATE.WAITING) throw new Error("Settings can only be changed while waiting.");

            room.updateSettings(settings); // Room method handles validation and broadcasting
        } catch (error) {
            console.warn(`[${room?.roomCode || 'No Room'}] Failed 'updateSettings' from ${socket.id}: ${error.message}`);
            socket.emit('errorMsg', error.message || 'Failed to update settings.');
        }
    });

    socket.on('startHiding', () => {
        const room = findRoomBySocketId(socket.id);
        try {
            if (!room) throw new Error("Not currently in a room.");
            const player = room.getPlayer(socket.id);
             if (!player || player.role !== PLAYER_ROLE.HIDER) throw new Error("Only the Hider can start the game.");

            room.startHidingPhase(); // Handles validation and broadcasting
        } catch (error) {
             console.warn(`[${room?.roomCode || 'No Room'}] Failed 'startHiding' from ${socket.id}: ${error.message}`);
             socket.emit('errorMsg', error.message || 'Failed to start hiding phase.');
        }
    });

    socket.on('confirmHidden', () => {
         const room = findRoomBySocketId(socket.id);
         try {
             if (!room) throw new Error("Not currently in a room.");
             room.confirmPlayerHidden(socket.id); // Handles validation and broadcasting/state change
         } catch (error) {
             console.warn(`[${room?.roomCode || 'No Room'}] Failed 'confirmHidden' from ${socket.id}: ${error.message}`);
             // No error message needed for client here typically
         }
    });

    socket.on('markSelfFound', () => {
         const room = findRoomBySocketId(socket.id);
          try {
             if (!room) throw new Error("Not currently in a room.");
             room.markPlayerFound(socket.id); // Handles validation, state changes, broadcasting
         } catch (error) {
             console.warn(`[${room?.roomCode || 'No Room'}] Failed 'markSelfFound' from ${socket.id}: ${error.message}`);
             // No error message needed for client here typically
         }
    });

    socket.on('requestPlayAgain', () => {
        const room = findRoomBySocketId(socket.id);
         try {
             if (!room) throw new Error("Not currently in a room.");
             room.requestPlayAgain(socket.id); // Handles validation and broadcasting
         } catch (error) {
             console.warn(`[${room?.roomCode || 'No Room'}] Failed 'requestPlayAgain' from ${socket.id}: ${error.message}`);
             socket.emit('errorMsg', error.message || 'Failed to request play again.');
         }
    });

    // --- Disconnect Handler ---
    const handleDisconnect = (disconnectedSocket) => {
        console.log(`Processing disconnect for: ${disconnectedSocket.id}.`);
        const room = findRoomBySocketId(disconnectedSocket.id);

        if (room) {
            const shouldDeleteRoom = room.removePlayer(disconnectedSocket.id); // removePlayer returns true if room becomes empty
            if (shouldDeleteRoom) {
                console.log(`[${room.roomCode}] Deleting empty room.`);
                delete activeRooms[room.roomCode];
            }
        } else {
            console.log(`Disconnected user ${disconnectedSocket.id} was not found in any active room.`);
        }
    };

    socket.on('disconnect', (reason) => {
        console.log(`User disconnected event: ${socket.id}. Reason: ${reason}`);
        handleDisconnect(socket); // Use the encapsulated handler
    });

});

// Helper to find the room a socket is in
function findRoomBySocketId(socketId) {
    for (const roomCode in activeRooms) {
        if (activeRooms[roomCode].players[socketId]) {
            return activeRooms[roomCode];
        }
    }
    return null;
}

// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Hide 'n' Seek Server listening on *:${PORT}`);
    console.log(`Serving static files from: ${PUBLIC_DIR}`);
    // Initial sound check warnings happen at the top
});