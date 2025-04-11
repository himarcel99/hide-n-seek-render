// Establish Socket.IO connection
const socket = io();

// === DOM Elements ===
const views = document.querySelectorAll('.view');
const audioEnableOverlay = document.getElementById('audio-enable-overlay');
const howToPlayModal = document.getElementById('howToPlayModal');
const closeHowToPlayBtn = document.getElementById('closeHowToPlayBtn');
const howToPlayBtn = document.getElementById('howToPlayBtn');

// Join View
const joinView = document.getElementById('join-view');
const roomCodeInput = document.getElementById('roomCodeInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinError = document.getElementById('join-error');

// Waiting Room View
const waitingRoomView = document.getElementById('waiting-room-view');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const playerList = document.getElementById('playerList');
const hiderControls = document.getElementById('hider-controls'); // Div containing Hider buttons
const seekTimeLimitInput = document.getElementById('seekTimeLimit');
const configureGameBtn = document.getElementById('configureGameBtn');
const startHidingBtn = document.getElementById('startHidingBtn'); // The button itself
const startError = document.getElementById('start-error');

// Hiding Phase View
const hidingView = document.getElementById('hiding-view');
const hidingInstructions = document.getElementById('hiding-instructions');
const hidingStatus = document.getElementById('hiding-status');
const confirmHiddenBtn = document.getElementById('confirmHiddenBtn');
const hidingConfirmedText = document.getElementById('hiding-confirmed-text');
const hidingCountdown = document.getElementById('hiding-countdown');

// Seeking Phase View
const seekingView = document.getElementById('seeking-view');
const timerDisplay = document.getElementById('timerDisplay');
const hiderStatusList = document.getElementById('hiderStatusList');
const hiddenDeviceUi = document.getElementById('hidden-device-ui');
const markSelfFoundBtn = document.getElementById('markSelfFoundBtn');
const alreadyFoundText = document.getElementById('alreadyFoundText');

// Game Over View
const gameOverView = document.getElementById('game-over-view');
const gameResult = document.getElementById('gameResult');
const gameOverReason = document.getElementById('gameOverReason');
const finalPlayerList = document.getElementById('finalPlayerList');
const hiderWinRevealSection = document.getElementById('hider-win-reveal-section');
const hiderWinStatus = document.getElementById('hider-win-status'); // Text element for status during reveal
const markFoundGameOverBtn = document.getElementById('markFoundGameOverBtn');
const gameOverFoundText = document.getElementById('gameOverFoundText');
const playAgainBtn = document.getElementById('playAgainBtn');

// === Client State ===
let myPlayerId = null;
let currentRoomState = null;
let seekTimerInterval = null; // For client-side display updates
let preSeekCountdownInterval = null; // Interval for hiding countdown display

// --- State for Tone.Player Audio ---
let audioPlayers = {}; // Cache for Tone.Player objects { url: player }
let activeUnfoundLoop = null; // Holds the Tone.Loop instance
let activeUnfoundPlayer = null; // Holds the Tone.Player instance being looped
let soundsPreloaded = false; // Flag to track if preloading has been initiated for the current game
let knownAnimalSoundURLs = []; // Store known animal sound URLs to easily stop them later

// === Tone.js Audio Playback using Tone.Player ===

/**
 * Ensures Tone.Transport is running. Needs to be called once after Tone.start().
 */
function ensureTransportRunning() {
    if (typeof Tone !== 'undefined' && Tone.Transport && Tone.Transport.state !== 'started') {
        try {
            Tone.Transport.start();
            console.log("Tone.Transport started.");
        } catch (e) {
            console.error("Error starting Tone.Transport:", e);
        }
    }
}

/**
 * Creates and stores a Tone.Player instance for a URL, initiating loading.
 * @param {string} url - The URL of the sound file.
 * @returns {Tone.Player | null} The Tone.Player instance or null on error.
 */
function loadPlayer(url) {
    if (!url) {
        console.warn("[Tone.Player] loadPlayer called with empty URL.");
        return null;
    }
    if (!audioPlayers[url]) {
        console.log(`[Tone.Player] Creating player and initiating load for: ${url}`);
        try {
            const player = new Tone.Player(url).toDestination();
            player.buffer.onload = () => console.log(`[Tone.Player] Buffer loaded: ${url}`);
            player.buffer.onerror = (e) => console.error(`[Tone.Player] Buffer error ${url}:`, e);
            audioPlayers[url] = player;
        } catch (e) {
             console.error(`[Tone.Player] Error creating Tone.Player for ${url}:`, e);
             return null;
        }
    }
    return audioPlayers[url];
}

/**
 * Initiates loading for all sounds associated with the current players + victory sound.
 * Stores the animal sound URLs for later stopping.
 * @param {object} players - The players object from the current room state.
 */
function preloadGameSounds(players) {
     if (soundsPreloaded || typeof Tone === 'undefined' || !Tone.context || Tone.context.state !== 'running') {
        if (!soundsPreloaded) console.warn("[Preload] Cannot preload sounds: Audio context not ready.");
        return;
     }
     console.log("[Preload] Initiating sound preloading...");
     const urlsToLoad = new Set(['/sounds/victory.mp3']);
     knownAnimalSoundURLs = []; // Reset known animal sounds for this game

     Object.values(players).forEach(p => {
         if (p.uniqueAnimalSoundURL) {
             urlsToLoad.add(p.uniqueAnimalSoundURL);
             knownAnimalSoundURLs.push(p.uniqueAnimalSoundURL); // Store animal sound URL
         }
         if (p.uniqueUnfoundSoundURL) urlsToLoad.add(p.uniqueUnfoundSoundURL);
     });

     console.log("[Preload] URLs to load:", Array.from(urlsToLoad));
     urlsToLoad.forEach(url => loadPlayer(url));
     soundsPreloaded = true;
}

/**
 * Stops all currently known seeking phase (animal) sounds.
 */
function stopAllSeekingSounds() {
    console.log("[Audio Stop] Stopping all known seeking sounds...");
    knownAnimalSoundURLs.forEach(url => {
        const player = audioPlayers[url];
        if (player && player.loaded && player.state === 'started') {
            try {
                player.stop(Tone.now());
                console.log(`[Audio Stop] Stopped player for ${url}`);
            } catch (e) {
                console.error(`[Audio Stop] Error stopping player for ${url}:`, e);
            }
        }
    });
}


/**
 * Plays an audio file once using Tone.Player ONLY if it's loaded.
 * @param {string} url - The relative URL of the audio file to play.
 * @param {string} context - A string describing the context (e.g., 'seeking', 'victory') for logging.
 */
function playAudio(url, context = 'general') {
    if (!url) {
        console.warn(`[${context}] playAudio called with no URL.`);
        return;
    }
    if (typeof Tone === 'undefined' || !Tone.context || Tone.context.state !== 'running') {
         console.error(`[${context}] Cannot play ${url}: Audio context not running.`);
         return;
    }
    console.log(`[${context}] Request to play: ${url}`);
    ensureTransportRunning();

    const player = audioPlayers[url];
    if (player) {
        if (player.loaded) {
            console.log(`[${context}] Player ${url} loaded. Starting.`);
            try {
                 player.stop(Tone.now()); // Stop previous instance if any
                 player.start(Tone.now());
            } catch (e) { console.error(`[${context}] Error starting ${url}:`, e); }
        } else {
            console.warn(`[${context}] Player ${url} exists but not loaded. Skipping.`);
        }
    } else {
        console.error(`[${context}] Player ${url} not found in cache. Skipping.`);
    }
}

/**
 * Stops the looping playback of the unfound sound thoroughly.
 */
function stopUnfoundSoundLoop() {
    // console.log("[Unfound Loop] Attempting to stop Tone.Loop..."); // Reduce noise
    if (activeUnfoundLoop) {
        activeUnfoundLoop.stop(Tone.now());
        activeUnfoundLoop.dispose();
        activeUnfoundLoop = null;
        console.log("[Unfound Loop] Tone.Loop stopped and disposed.");
    }
    if (activeUnfoundPlayer) {
        console.log("[Unfound Loop] Stopping active Tone.Player instance.");
        activeUnfoundPlayer.stop(Tone.now());
        activeUnfoundPlayer = null;
    }
}


/**
 * Starts the looping playback for the unfound sound reveal using Tone.Loop.
 * Only starts if the Tone.Player for the URL is loaded.
 * @param {string} url - The URL of the unfound sound file.
 */
function startUnfoundSoundLoop(url) {
    if (!url) { console.error("[Unfound Loop] Cannot start: No URL."); return; }
    if (typeof Tone === 'undefined' || !Tone.context || Tone.context.state !== 'running') {
        console.error(`[Unfound Loop] Cannot start ${url}: Audio context not running.`); return;
    }
    stopUnfoundSoundLoop(); // Ensure previous loop is stopped
    console.log(`[Unfound Loop] Attempting start for: ${url}`);
    ensureTransportRunning();

    const player = audioPlayers[url];
    if (player && player.loaded) {
        const duration = player.buffer.duration;
        if (!duration || duration <= 0) { console.error(`[Unfound Loop] Invalid duration ${url}.`); return; }
        const interval = duration + 1.0; // Loop slightly longer than duration
        console.log(`[Unfound Loop] Player ${url} loaded (duration: ${duration}s). Setting up Loop interval ${interval}s.`);
        activeUnfoundPlayer = player;
        try {
            activeUnfoundLoop = new Tone.Loop(time => {
                if (activeUnfoundPlayer && activeUnfoundPlayer.loaded) {
                     // console.log(`[Unfound Loop] Loop playing ${url} at ${time}`); // Reduce noise
                     activeUnfoundPlayer.start(time);
                } else { stopUnfoundSoundLoop(); } // Stop if player becomes unloaded
            }, interval).start(Tone.now());
            console.log(`[Unfound Loop] Tone.Loop started for ${url}.`);
        } catch (e) { console.error(`[Unfound Loop] Error starting Loop ${url}:`, e); activeUnfoundPlayer = null; }
    } else if (player && !player.loaded) {
         console.error(`[Unfound Loop] Player ${url} exists but not loaded. Cannot start loop.`);
    } else {
         console.error(`[Unfound Loop] Player ${url} not found in cache. Cannot start loop.`);
    }
}


// === View Management ===
/**
 * Shows the specified view and hides all others.
 * @param {string} viewId - The ID of the view element to show.
 */
function showView(viewId) {
    views.forEach(view => {
        if (view.id === viewId) {
            view.classList.add('active');
            view.classList.remove('hidden');
        } else {
            view.classList.remove('active');
            view.classList.add('hidden');
        }
    });
    // Special handling for modal
    if (viewId === 'howToPlayModal') {
        howToPlayModal.classList.remove('hidden');
        howToPlayModal.classList.add('flex');
    } else if (howToPlayModal.classList.contains('flex')) {
        howToPlayModal.classList.add('hidden');
        howToPlayModal.classList.remove('flex');
    }
    console.log("Showing view:", viewId);
}

// === Helper Functions ===
/**
 * Formats seconds into MM:SS format.
 * @param {number} totalSeconds - The total seconds to format.
 * @returns {string} Formatted time string.
 */
function formatTime(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Renders the player list in the Waiting Room. Shows "Phone X".
 * Highlights the Hider.
 * @param {object} players - The players object from the server state.
 * @param {string} myId - The client's own socket ID.
 */
function renderPlayerList(players, myId) {
    playerList.innerHTML = ''; // Clear previous list
    Object.values(players).sort((a, b) => a.number - b.number).forEach(player => {
        const li = document.createElement('li');
        li.classList.add('text-lg', 'p-1'); // Basic styling
        // Display "Phone X"
        li.textContent = `Phone ${player.number}`;
        // Highlight if this client is the Hider (using the role property)
        if (player.id === myId && player.role === 'Hider') {
             li.classList.add('bg-indigo-900', 'rounded', 'font-semibold', 'text-white');
        }
        playerList.appendChild(li);
    });
}


/**
 * Renders the status of hiders (phones) in the Seeking Phase.
 * @param {object} players - The players object from the server state.
 */
function renderHiderStatusList(players) {
    hiderStatusList.innerHTML = '';
    Object.values(players).sort((a, b) => a.number - b.number).forEach(player => {
        const li = document.createElement('li');
        li.classList.add('text-lg');
        if (player.isFound) {
            li.innerHTML = `Phone ${player.number}: <span class="text-green-400">✅ Found</span>`;
        } else {
            li.innerHTML = `Phone ${player.number}: <span class="text-gray-400">❓ Hidden</span>`;
        }
        hiderStatusList.appendChild(li);
    });
}

/**
 * Renders the final player status list in the Game Over view.
 * Highlights the player currently playing the reveal sound.
 * @param {object} players - The players object from the server state.
 */
function renderFinalPlayerList(players) {
    finalPlayerList.innerHTML = '';
    Object.values(players).sort((a, b) => a.number - b.number).forEach(player => {
        const li = document.createElement('li');
        li.classList.add('text-lg', 'p-1', 'rounded');
        if (player.isFound) {
            li.innerHTML = `Phone ${player.number} <span class="text-green-400">Found ✅</span>`;
        } else {
            li.innerHTML = `Phone ${player.number} <span class="text-red-400">Not Found ❌</span>`;
            // Highlight the active unfound player during reveal
            if (currentRoomState?.gameState === 'GameOver' && player.id === currentRoomState.activeUnfoundPlayerId) {
                 li.classList.add('bg-yellow-800', 'font-bold', 'animate-pulse');
                 li.innerHTML += ' <span class="text-yellow-300">(Playing Sound...)</span>'; // Indicate sound playing
            }
        }
        finalPlayerList.appendChild(li);
    });
}

/**
 * Updates the timer display during the Seeking phase based on server start time.
 */
function updateTimerDisplay() {
    if (currentRoomState && currentRoomState.gameState === 'Seeking' && currentRoomState.seekStartTime) {
        const elapsed = (Date.now() - currentRoomState.seekStartTime) / 1000;
        const remaining = currentRoomState.seekTimeLimit - elapsed;
        timerDisplay.textContent = formatTime(remaining);
        if (remaining <= 0 && seekTimerInterval) {
             clearInterval(seekTimerInterval);
             seekTimerInterval = null;
             timerDisplay.textContent = "00:00";
        }
    } else {
        // Display the full time limit if seeking hasn't started or state is missing
        timerDisplay.textContent = formatTime(currentRoomState?.seekTimeLimit || 0);
        if(seekTimerInterval) {
            clearInterval(seekTimerInterval);
            seekTimerInterval = null;
        }
    }
}


// === Socket Event Handlers ===

socket.on('connect', () => {
    console.log('Connected to server with ID:', socket.id);
    myPlayerId = socket.id; // Store my ID when connected
});

socket.on('disconnect', (reason) => {
    console.log('Disconnected from server:', reason);
    stopUnfoundSoundLoop(); // Stop any looping sounds on disconnect
    // If disconnected mid-game, show an alert and reset view
    if (currentRoomState && currentRoomState.gameState !== 'Waiting' && currentRoomState.gameState !== 'GameOver') {
        showView('join-view');
        // Use a more user-friendly alert or modal here in a real app
        alert('Connection lost to the server. Please rejoin or create a new game.');
        currentRoomState = null; // Reset local state
        // Clear intervals
        if(seekTimerInterval) clearInterval(seekTimerInterval);
        seekTimerInterval = null;
        if(preSeekCountdownInterval) clearInterval(preSeekCountdownInterval);
        preSeekCountdownInterval = null;
        // Reset audio state
        soundsPreloaded = false;
        Object.values(audioPlayers).forEach(player => player?.dispose());
        audioPlayers = {};
        knownAnimalSoundURLs = [];
    }
});

// Handle generic error messages from the server
socket.on('errorMsg', (message) => {
    console.error('Server Error:', message);
    // Display error in the appropriate view's error paragraph
    if (joinView.classList.contains('active')) {
        joinError.textContent = message;
    } else if (waitingRoomView.classList.contains('active')) {
        startError.textContent = message;
    } else {
        // Fallback alert if no specific view is active
        alert(`Error: ${message}`);
    }
    // Clear the error message after a few seconds
    setTimeout(() => {
        joinError.textContent = '';
        startError.textContent = '';
    }, 4000);
});

// Main handler for receiving state updates from the server
socket.on('updateState', (state) => {
    console.log('Received state update:', state);
    const previousState = currentRoomState?.gameState; // Store previous state for transitions
    currentRoomState = state; // Store the latest state FIRST

    // --- Preload sounds ---
    // Preload sounds if in Waiting or Hiding state and not already preloaded
    if ((state.gameState === 'Waiting' || state.gameState === 'Hiding') && !soundsPreloaded) {
        if (typeof Tone !== 'undefined' && Tone.context && Tone.context.state === 'running') {
             preloadGameSounds(state.players);
        } else {
            console.warn("Cannot preload sounds yet: Audio context not running.");
        }
    }
    // Reset preload flag and audio cache if returning to Waiting after Game Over
    if (state.gameState === 'Waiting' && previousState === 'GameOver') {
        console.log("Resetting preload flag and audio cache for new game.");
        soundsPreloaded = false;
        Object.values(audioPlayers).forEach(player => player?.dispose());
        audioPlayers = {};
        knownAnimalSoundURLs = [];
    }


    // Clear intervals/loops based on state transitions
    if (state.gameState !== 'Seeking' && seekTimerInterval) {
        clearInterval(seekTimerInterval);
        seekTimerInterval = null;
    }
    if (state.gameState !== 'Hiding' && preSeekCountdownInterval) {
        clearInterval(preSeekCountdownInterval);
        preSeekCountdownInterval = null;
        hidingCountdown.textContent = '-'; // Reset countdown display
    }
    // Stop unfound loop unless it's specifically meant to be playing (Game Over, Hider Win, this client is active)
    if (!(state.gameState === 'GameOver' && state.winner === 'Hider' && state.activeUnfoundPlayerId === myPlayerId)) {
         stopUnfoundSoundLoop();
    }
    // Stop all seeking (animal) sounds if transitioning out of the Seeking state
    if (previousState === 'Seeking' && state.gameState !== 'Seeking') {
        stopAllSeekingSounds();
    }


    // --- Update UI based on Game State ---
    switch (state.gameState) {
        case 'Waiting':
            showView('waiting-room-view');
            roomCodeDisplay.textContent = state.roomCode;
            seekTimeLimitInput.value = state.seekTimeLimit;
            renderPlayerList(state.players, myPlayerId); // Render player list (now highlights Hider)

            // --- Check Hider Role and Show Controls ---
            const myPlayerDataWaiting = state.players[myPlayerId]; // Get my data using my ID
            const amIHiderWaiting = myPlayerDataWaiting?.role === 'Hider'; // Check role

            // Log debugging info (can be removed in production)
            console.log("[Waiting View] My ID:", myPlayerId);
            console.log("[Waiting View] My Player Data:", myPlayerDataWaiting ? JSON.stringify(myPlayerDataWaiting) : 'Not Found');
            console.log("[Waiting View] Am I Hider Check:", amIHiderWaiting);
            console.log("[Waiting View] Hider Controls Element:", hiderControls);

            // Toggle visibility of Hider controls based on the role check
            hiderControls.classList.toggle('hidden', !amIHiderWaiting);

            // Enable/disable start button if Hider controls are visible
            if(amIHiderWaiting && startHidingBtn) {
                 const canStart = Object.keys(state.players).length >= 2; // Need at least 2 players
                 startHidingBtn.disabled = !canStart;
                 startError.textContent = canStart ? '' : 'Waiting for more players...';
            } else if (!amIHiderWaiting) {
                 startError.textContent = ''; // Clear error if not hider
            }
            // --- End Hider Role Check ---

            // Reset UI elements from other states
            hidingCountdown.textContent = '-';
            timerDisplay.textContent = formatTime(state.seekTimeLimit);
            playAgainBtn.classList.add('hidden');
            hiderWinRevealSection.classList.add('hidden');
            break;

        case 'Hiding':
            showView('hiding-view');
            const myPlayerDataHiding = state.players[myPlayerId];
            let readyCount = 0;
            // Count how many players are ready
            Object.values(state.players).forEach(p => { if (p.isReady) readyCount++; });
            // Update status text
            hidingStatus.textContent = `(${readyCount}/${Object.keys(state.players).length} phones confirmed hidden)`;

            const isClientReady = myPlayerDataHiding?.isReady;
            // Show/hide the confirm button vs the confirmation text
            confirmHiddenBtn.classList.toggle('hidden', isClientReady);
            hidingConfirmedText.classList.toggle('hidden', !isClientReady);
            // Hiding instructions text is static in HTML

            // Ensure countdown display is reset if interval isn't running
            if (!preSeekCountdownInterval) {
                 hidingCountdown.textContent = '-';
            }
            break;

        case 'Seeking':
            showView('seeking-view');
            renderHiderStatusList(state.players); // Update list of found/hidden phones
            // Start the client-side timer display if it's not running and start time is known
            if (!seekTimerInterval && state.seekStartTime) {
                updateTimerDisplay(); // Initial update
                seekTimerInterval = setInterval(updateTimerDisplay, 1000); // Update every second
            } else if (!state.seekStartTime) {
                // If start time isn't set yet, just display the full limit
                timerDisplay.textContent = formatTime(state.seekTimeLimit);
            }
            const myPlayerDataSeeking = state.players[myPlayerId];
            const isClientFoundSeeking = myPlayerDataSeeking?.isFound;
            // Show/hide the "Mark Found" button vs the "Found!" text
            hiddenDeviceUi.classList.toggle('hidden', isClientFoundSeeking);
            alreadyFoundText.classList.toggle('hidden', !isClientFoundSeeking);
            break;

        case 'GameOver':
            showView('game-over-view');
            renderFinalPlayerList(state.players); // Render final status list (now highlights active reveal player)

            if (state.winner === 'Seekers') {
                gameResult.textContent = 'Seekers Win!';
                gameResult.className = 'text-3xl font-semibold text-green-400';
                gameOverReason.textContent = 'All phones were found before time ran out.';
                hiderWinRevealSection.classList.add('hidden'); // Hide the reveal section
            } else if (state.winner === 'Hider') {
                gameResult.textContent = 'Hider Wins!';
                gameResult.className = 'text-3xl font-semibold text-red-400';
                gameOverReason.textContent = 'Time ran out before all phones were found.';
                hiderWinRevealSection.classList.remove('hidden'); // Show the reveal section

                const myPlayerDataGameOver = state.players[myPlayerId];
                const amIActiveUnfound = state.activeUnfoundPlayerId === myPlayerId;
                const isClientFoundGameOver = myPlayerDataGameOver?.isFound;

                // FIX: Update status text only when reveal is finished or no one is active
                if (state.activeUnfoundPlayerId) {
                    // Clear the status text while a player is actively revealing
                    hiderWinStatus.textContent = ''; // Removed "Finding Phone X..." text
                    hiderWinStatus.className = 'text-xl'; // Reset class if needed
                } else {
                    // Display completion message when queue is empty
                    hiderWinStatus.textContent = 'All remaining phones found!';
                    hiderWinStatus.className = 'text-xl text-green-400';
                    stopUnfoundSoundLoop(); // Ensure loop stops when reveal finishes
                }

                // Show/hide the "Mark Found" button for the active reveal player
                markFoundGameOverBtn.classList.toggle('hidden', isClientFoundGameOver || !amIActiveUnfound);
                // Show/hide the "Found!" text
                gameOverFoundText.classList.toggle('hidden', !isClientFoundGameOver);

            } else {
                // Handle unexpected game over state
                gameResult.textContent = 'Game Over';
                 gameResult.className = 'text-3xl font-semibold text-gray-400';
                gameOverReason.textContent = 'The game ended unexpectedly.';
                hiderWinRevealSection.classList.add('hidden');
                 stopUnfoundSoundLoop();
            }
            playAgainBtn.classList.remove('hidden'); // Show Play Again button
            break;

        default:
            // Handle unknown game state by resetting to join view
            console.warn("Unknown game state received:", state.gameState);
            stopUnfoundSoundLoop();
            showView('join-view');
            break;
    }
});


// Handle pre-seek countdown updates from the server
socket.on('preSeekCountdown', (value) => {
    console.log('Countdown:', value);
    if (currentRoomState?.gameState === 'Hiding') {
        hidingCountdown.textContent = value > 0 ? value : "0"; // Display countdown value (or 0)
        // Add visual pulse effect for the last few seconds
        hidingCountdown.classList.toggle('pulse', value <= 3 && value > 0);
        hidingCountdown.classList.toggle('text-red-600', value <= 3 && value > 0);
    }
});

// Listen for the animal sound trigger from the server
socket.on('playSound', (profile) => {
    // Only play sound if this client is not yet found
    if (currentRoomState?.players[myPlayerId] && !currentRoomState.players[myPlayerId].isFound) {
        console.log('Received playSound request:', profile);
        playAudio(profile.soundURL, 'seeking'); // Play the assigned animal sound
    } else {
         console.log('Received playSound request but I am already found. Ignoring.');
    }
});

// Listen for the unfound sound trigger (sent only to the active player during Hider reveal)
socket.on('becomeActiveUnfound', (profile) => {
    console.log('Received becomeActiveUnfound request:', profile);
    stopAllSeekingSounds(); // Stop any lingering seeking sounds first
    // Ensure the "Mark Found" button is visible and "Found" text is hidden for this player
    if (markFoundGameOverBtn) markFoundGameOverBtn.classList.remove('hidden');
    if (gameOverFoundText) gameOverFoundText.classList.add('hidden');
    startUnfoundSoundLoop(profile.soundURL); // Start looping the unfound sound
});

// Listen for the victory melody trigger (sent to all players on Seeker win)
socket.on('playVictoryMelody', () => {
    console.log('Received playVictoryMelody request.');
    stopAllSeekingSounds(); // Stop any lingering seeking sounds first
    playAudio('/sounds/victory.mp3', 'victory'); // Play the victory sound
});


// === Event Listeners ===

// Use Tone.start() for reliable audio context unlocking on first user interaction
audioEnableOverlay.addEventListener('click', () => {
    console.log("Audio enable overlay clicked.");

    // --- UI Update First ---
    audioEnableOverlay.classList.add('hidden');
    audioEnableOverlay.classList.remove('active', 'flex');
    showView('join-view'); // Show the initial join view
    console.log("Overlay hidden, join view shown.");
    // --- End UI Update ---

    // --- Attempt Audio Context Start ---
    if (typeof Tone === 'undefined') {
         console.error("Tone.js library not loaded. Cannot start audio context.");
         return;
    }
    // Try to start/resume the AudioContext if it's not already running
    if (Tone.context.state !== 'running') {
        console.log("Attempting Tone.start()...");
        Tone.start().then(() => {
            console.log("Tone.start() successful. Audio context is running.");
            ensureTransportRunning(); // Ensure Tone.Transport is started after context is running
        }).catch(e => {
            console.error("Tone.start() failed:", e);
            // Warn user that audio might not work
            console.warn("Tone.start() failed. Subsequent audio playback might fail.");
        });
    } else {
         console.log("Audio context already running.");
         ensureTransportRunning(); // Ensure transport is running if context was already active
    }
});


// Show/Hide How to Play modal
howToPlayBtn.addEventListener('click', () => {
    howToPlayModal.classList.remove('hidden');
    howToPlayModal.classList.add('flex');
});

closeHowToPlayBtn.addEventListener('click', () => {
    howToPlayModal.classList.add('hidden');
    howToPlayModal.classList.remove('flex');
});

// Join Room button
joinRoomBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (code.length === 5) {
        joinError.textContent = ''; // Clear previous errors
        socket.emit('joinRoom', code); // Send join request to server
    } else {
        joinError.textContent = 'Room code must be 5 characters.';
    }
});

// Create Room button
createRoomBtn.addEventListener('click', () => {
    joinError.textContent = ''; // Clear previous errors
    socket.emit('createRoom'); // Send create request to server
});

// Configure Game button (Hider only)
configureGameBtn.addEventListener('click', () => {
    const timeLimit = parseInt(seekTimeLimitInput.value, 10);
    if (!isNaN(timeLimit) && timeLimit >= 15 && timeLimit <= 600) {
        startError.textContent = ''; // Clear previous errors
        socket.emit('configureGame', { seekTimeLimit: timeLimit }); // Send config update
    } else {
         startError.textContent = 'Time limit must be between 15 and 600 seconds.';
    }
});

// Start Hiding button (Hider only)
startHidingBtn.addEventListener('click', () => {
    startError.textContent = ''; // Clear previous errors
    socket.emit('startHiding'); // Send request to start hiding phase
});

// Confirm Hidden button (Hiding phase)
confirmHiddenBtn.addEventListener('click', () => {
    // Immediately update UI for responsiveness (server will confirm via state update)
    confirmHiddenBtn.classList.add('hidden');
    hidingConfirmedText.classList.remove('hidden');
    socket.emit('confirmHidden'); // Inform server this player is hidden
});

// Mark Self Found button (Seeking phase)
markSelfFoundBtn.addEventListener('click', () => {
    // Immediately update UI
    hiddenDeviceUi.classList.add('hidden');
    alreadyFoundText.classList.remove('hidden');
    socket.emit('markSelfFound'); // Inform server this player was found
});

// Mark Found button (Game Over Hider reveal)
markFoundGameOverBtn.addEventListener('click', () => {
    console.log("Mark Found (Game Over) button clicked.");
    stopUnfoundSoundLoop(); // Stop the reveal sound immediately
    // Immediately update UI
    markFoundGameOverBtn.classList.add('hidden');
    gameOverFoundText.classList.remove('hidden');
    socket.emit('markSelfFound'); // Inform server this player was found
});

// Play Again button (Game Over)
playAgainBtn.addEventListener('click', () => {
    stopUnfoundSoundLoop(); // Stop any reveal sounds
    // Reset audio state flags and cache
    soundsPreloaded = false;
    Object.values(audioPlayers).forEach(player => player?.dispose());
    audioPlayers = {};
    knownAnimalSoundURLs = [];
    socket.emit('requestPlayAgain'); // Send request to server to reset the game
});

// Initial setup
console.log("Client script loaded. Using Tone.Player with preloading strategy.");
// Audio overlay is shown initially via CSS/HTML 'active' class