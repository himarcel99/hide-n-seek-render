/**
 * client.js (Refactored)
 *
 * Client-side logic for the Hide 'n' Seek web application.
 * Handles UI updates, user interactions, audio playback (Tone.js),
 * and communication with the server via Socket.IO.
 * Refactored using objects to simulate modules for better organization.
 */

// Wrap all logic in an IIFE to avoid polluting the global scope
(function() {
    'use strict';

    // =========================================================================
    // == Constants
    // =========================================================================
    const VIEW_IDS = Object.freeze({
        JOIN: 'join-view',
        WAITING_ROOM: 'waiting-room-view',
        HIDING: 'hiding-view',
        SEEKING: 'seeking-view',
        GAME_OVER: 'game-over-view',
        HOW_TO_PLAY: 'howToPlayModal'
    });

    // Mirror server-side constants needed on client
    const GAME_STATE = Object.freeze({
        WAITING: 'Waiting',
        HIDING: 'Hiding',
        SEEKING: 'Seeking',
        GAME_OVER: 'GameOver',
    });

    const PLAYER_ROLE = Object.freeze({
        HIDER: 'Hider',
        SEEKER: 'Seeker',
    });

     const WINNER_TYPE = Object.freeze({
        HIDER: 'Hider',
        SEEKERS: 'Seekers',
    });

    // Settings constants for client-side validation/defaults
    const MIN_SEEK_TIME_LIMIT_S = 15;
    const MAX_SEEK_TIME_LIMIT_S = 600;
    const DEFAULT_SOUND_PLAYS_PER_PLAYER = 6;
    const MIN_SOUND_PLAYS = 1;
    const MAX_SOUND_PLAYS = 20;

    const SOUND_URLS = Object.freeze({
        VICTORY: '/sounds/victory.mp3',
        FOUND: '/sounds/found.mp3',
        FAIL: '/sounds/fail.mp3' // For game over reveal find
    });

    const VIBRATION_DURATION_MS = 200;
    const ROOM_CODE_LENGTH = 5; // Used for input validation

    // =========================================================================
    // == Client State
    // =========================================================================
    let myPlayerId = null;
    let currentRoomState = null;
    let seekTimerInterval = null;
    let audioContextStarted = false;
    let soundsPreloaded = false;
    let activeViewId = VIEW_IDS.JOIN; // Track the currently intended active view

    // =========================================================================
    // == DOM Element Cache (Managed by UIManager)
    // =========================================================================
    const DOMElements = {}; // Populated by UIManager.init

    // =========================================================================
    // == Audio Manager (Tone.js)
    // =========================================================================
    const AudioManager = {
        audioPlayers: {}, // Cache for Tone.Player instances { url: Tone.Player }
        activeUnfoundLoop: null,
        activeUnfoundPlayer: null,
        knownAnimalSoundURLs: [], // URLs specific to the current game instance

        /** Attempts to start the Tone.js Audio Context. MUST be called after user interaction. */
        attemptStart: function() {
            // Only attempt if Tone is available and context is not already running
            if (!audioContextStarted && typeof Tone !== 'undefined' && Tone.context && Tone.context.state !== 'running') {
                console.log("Attempting Tone.start() due to user interaction...");
                Tone.start().then(() => {
                    console.log("Tone.start() successful. Audio context is running.");
                    audioContextStarted = true;
                    this.ensureTransportRunning();
                    // If a game state already exists (e.g., user reconnected), try preloading now
                    // Use client-side GAME_STATE constants
                    if (currentRoomState && (currentRoomState.gameState === GAME_STATE.WAITING || currentRoomState.gameState === GAME_STATE.HIDING)) {
                         this.preloadGameSounds(currentRoomState.players);
                    }
                }).catch(e => {
                    console.error("Tone.start() failed:", e);
                    // Show user-facing error in the join view's error area
                    UIManager.showError("Audio could not be initialized. Sound may not work.", DOMElements.joinError);
                });
            } else if (audioContextStarted) {
                // If context already started, ensure transport is running
                this.ensureTransportRunning();
            } else if (typeof Tone === 'undefined') {
                 console.error("Tone.js not available. Cannot start audio.");
                 UIManager.showError("Audio library failed to load. Please refresh.", DOMElements.joinError);
            }
        },

        /** Ensures Tone.Transport is running if the audio context is active. */
        ensureTransportRunning: function() {
            if (audioContextStarted && typeof Tone !== 'undefined' && Tone.Transport && Tone.Transport.state !== 'started') {
                try {
                    Tone.Transport.start();
                } catch (e) {
                    console.error("Error starting Tone.Transport:", e);
                }
            }
        },

        /** Creates/caches a Tone.Player, initiating loading. */
        loadPlayer: function(url) {
            if (!url || typeof url !== 'string') {
                console.warn("[Audio Load] Invalid URL:", url);
                return null;
            }
            if (!this.audioPlayers[url]) {
                console.log(`[Audio Load] Creating player for: ${url}`);
                try {
                    const player = new Tone.Player(url).toDestination();
                    player.buffer.onload = () => console.log(`[Audio Load] Buffer loaded: ${url}`);
                    player.buffer.onerror = (e) => console.error(`[Audio Load] Buffer error for ${url}:`, e);
                    this.audioPlayers[url] = player;
                } catch (e) {
                    console.error(`[Audio Load] Error creating Tone.Player for ${url}:`, e);
                    return null;
                }
            }
            return this.audioPlayers[url];
        },

        /** Initiates loading for all necessary game sounds. */
        preloadGameSounds: function(players) {
            if (soundsPreloaded || !audioContextStarted || typeof Tone === 'undefined') {
                if (!soundsPreloaded && !audioContextStarted) console.warn("[Preload] Cannot preload: Audio context not running.");
                return;
            }
            console.log("[Preload] Initiating sound preloading...");

            const urlsToLoad = new Set([SOUND_URLS.VICTORY, SOUND_URLS.FOUND, SOUND_URLS.FAIL]);
            this.knownAnimalSoundURLs = []; // Reset for this game

            Object.values(players || {}).forEach(p => {
                if (p.uniqueAnimalSoundURL) {
                    urlsToLoad.add(p.uniqueAnimalSoundURL);
                    this.knownAnimalSoundURLs.push(p.uniqueAnimalSoundURL);
                }
                if (p.uniqueUnfoundSoundURL) {
                    urlsToLoad.add(p.uniqueUnfoundSoundURL);
                }
            });

            console.log("[Preload] URLs to load:", Array.from(urlsToLoad));
            urlsToLoad.forEach(url => this.loadPlayer(url));
            soundsPreloaded = true;
        },

        /** Stops playback for all known seeking phase (animal) sounds. */
        stopAllSeekingSounds: function() {
            console.log("[Audio Stop] Stopping all known seeking sounds...");
            this.knownAnimalSoundURLs.forEach(url => {
                const player = this.audioPlayers[url];
                if (player && player.loaded && player.state === 'started') {
                    try {
                        player.stop(Tone.now());
                    } catch (e) {
                        console.error(`[Audio Stop] Error stopping player for ${url}:`, e);
                    }
                }
            });
        },

        /** Plays a sound file once using its cached Tone.Player instance. */
        play: function(url, context = 'general') {
            if (!url) {
                console.warn(`[${context}] playAudio called with invalid URL.`);
                return;
            }
            if (!audioContextStarted || typeof Tone === 'undefined') {
                console.error(`[${context}] Cannot play ${url}: Audio context not running.`);
                return;
            }
            this.ensureTransportRunning();

            const player = this.audioPlayers[url];
            if (player) {
                if (player.loaded) {
                    try {
                        player.stop(Tone.now()); // Stop previous playback first
                        player.start(Tone.now());
                    } catch (e) {
                        console.error(`[${context}] Error starting playback for ${url}:`, e);
                    }
                } else {
                    console.warn(`[${context}] Player ${url} exists but not loaded. Skipping.`);
                    // Optionally trigger loading again if needed
                    // this.loadPlayer(url);
                }
            } else {
                console.error(`[${context}] Player ${url} not found. Cannot play.`);
                this.loadPlayer(url); // Attempt to load if missing
            }
        },

        /** Stops the looping playback of the unfound sound. */
        stopUnfoundSoundLoop: function() {
            if (this.activeUnfoundLoop) {
                try {
                    this.activeUnfoundLoop.stop(Tone.now()).dispose();
                    console.log("[Unfound Loop] Tone.Loop stopped and disposed.");
                } catch(e) { console.error("[Unfound Loop] Error stopping/disposing Tone.Loop:", e); }
                this.activeUnfoundLoop = null;
            }
            if (this.activeUnfoundPlayer) {
                 if (this.activeUnfoundPlayer.loaded && this.activeUnfoundPlayer.state === 'started') {
                     try { this.activeUnfoundPlayer.stop(Tone.now()); }
                     catch(e) { console.error("[Unfound Loop] Error stopping active Tone.Player:", e); }
                 }
                this.activeUnfoundPlayer = null;
            }
        },

        /** Starts looping playback for the unfound sound reveal. */
        startUnfoundSoundLoop: function(url) {
            if (!url) { console.error("[Unfound Loop] Cannot start: No URL provided."); return; }
            if (!audioContextStarted || typeof Tone === 'undefined') {
                console.error(`[Unfound Loop] Cannot start ${url}: Audio context not running.`); return;
            }

            this.stopUnfoundSoundLoop(); // Ensure previous loop is stopped
            console.log(`[Unfound Loop] Attempting to start loop for: ${url}`);
            this.ensureTransportRunning();

            const player = this.audioPlayers[url];
            if (player && player.loaded) {
                const duration = player.buffer.duration;
                if (!duration || duration <= 0) {
                    console.error(`[Unfound Loop] Cannot start: Invalid audio duration for ${url}.`); return;
                }
                const intervalSeconds = duration + 1.0; // Loop slightly longer than duration
                console.log(`[Unfound Loop] Player ${url} loaded (Duration: ${duration.toFixed(2)}s). Interval: ${intervalSeconds.toFixed(2)}s.`);

                this.activeUnfoundPlayer = player;
                try {
                    this.activeUnfoundLoop = new Tone.Loop(time => {
                        if (this.activeUnfoundPlayer && this.activeUnfoundPlayer.loaded) {
                            this.activeUnfoundPlayer.start(time);
                            if (navigator.vibrate) { navigator.vibrate(VIBRATION_DURATION_MS); }
                        } else {
                            console.warn("[Unfound Loop] Player became unloaded/invalid. Stopping loop.");
                            this.stopUnfoundSoundLoop();
                        }
                    }, intervalSeconds).start(Tone.now());
                    console.log(`[Unfound Loop] Tone.Loop started successfully for ${url}.`);
                } catch (e) {
                    console.error(`[Unfound Loop] Error starting Tone.Loop for ${url}:`, e);
                    this.activeUnfoundPlayer = null;
                }
            } else {
                 console.error(`[Unfound Loop] Cannot start: Player ${url} not found or not loaded.`);
                 if (!player) this.loadPlayer(url); // Attempt load if missing
            }
        },

        /** Resets audio state and disposes players. */
        resetState: function() {
            console.log("[Audio Reset] Resetting audio state.");
            this.stopUnfoundSoundLoop();
            this.stopAllSeekingSounds();

            Object.values(this.audioPlayers).forEach(player => {
                try { player?.dispose(); }
                catch (e) { console.warn("[Audio Reset] Error disposing player:", e); }
            });

            this.audioPlayers = {};
            this.knownAnimalSoundURLs = [];
            soundsPreloaded = false;
            // Keep audioContextStarted = true if it was already started
        }
    };

    // =========================================================================
    // == UI Manager
    // =========================================================================
    const UIManager = {
        /** Caches all required DOM elements. */
        init: function() {
            console.log("UIManager: Initializing and caching DOM elements.");
            // Query all views
            DOMElements.views = document.querySelectorAll('.view');

            // Cache elements for each view/component
            DOMElements.howToPlayModal = document.getElementById('howToPlayModal');
            DOMElements.closeHowToPlayBtn = document.getElementById('closeHowToPlayBtn');
            DOMElements.howToPlayBtn = document.getElementById('howToPlayBtn');

            DOMElements.joinView = document.getElementById(VIEW_IDS.JOIN);
            DOMElements.roomCodeInput = document.getElementById('roomCodeInput');
            DOMElements.joinRoomBtn = document.getElementById('joinRoomBtn');
            DOMElements.createRoomBtn = document.getElementById('createRoomBtn');
            DOMElements.joinError = document.getElementById('join-error');

            DOMElements.waitingRoomView = document.getElementById(VIEW_IDS.WAITING_ROOM);
            DOMElements.roomCodeDisplay = document.getElementById('roomCodeDisplay');
            DOMElements.playerList = document.getElementById('playerList');
            DOMElements.hiderControls = document.getElementById('hider-controls');
            DOMElements.seekTimeLimitInput = document.getElementById('seekTimeLimit');
            DOMElements.soundPlaysInput = document.getElementById('soundPlaysInput');
            DOMElements.updateSettingsBtn = document.getElementById('updateSettingsBtn');
            DOMElements.startHidingBtn = document.getElementById('startHidingBtn');
            DOMElements.startError = document.getElementById('start-error');
            DOMElements.backToJoinBtn = document.getElementById('backToJoinBtn');

            DOMElements.hidingView = document.getElementById(VIEW_IDS.HIDING);
            DOMElements.hidingInstructions = document.getElementById('hiding-instructions');
            DOMElements.hidingStatus = document.getElementById('hiding-status');
            DOMElements.confirmHiddenBtn = document.getElementById('confirmHiddenBtn');
            DOMElements.hidingConfirmedText = document.getElementById('hiding-confirmed-text');
            DOMElements.hidingCountdown = document.getElementById('hiding-countdown');

            DOMElements.seekingView = document.getElementById(VIEW_IDS.SEEKING);
            DOMElements.timerDisplay = document.getElementById('timerDisplay');
            DOMElements.hiderStatusList = document.getElementById('hiderStatusList');
            DOMElements.hiddenDeviceUi = document.getElementById('hidden-device-ui');
            DOMElements.markSelfFoundBtn = document.getElementById('markSelfFoundBtn');
            DOMElements.alreadyFoundText = document.getElementById('alreadyFoundText');

            DOMElements.gameOverView = document.getElementById(VIEW_IDS.GAME_OVER);
            DOMElements.gameResult = document.getElementById('gameResult');
            DOMElements.gameOverReason = document.getElementById('gameOverReason');
            DOMElements.finalPlayerList = document.getElementById('finalPlayerList');
            DOMElements.hiderWinRevealSection = document.getElementById('hider-win-reveal-section');
            DOMElements.hiderWinStatus = document.getElementById('hider-win-status');
            DOMElements.markFoundGameOverBtn = document.getElementById('markFoundGameOverBtn');
            DOMElements.gameOverFoundText = document.getElementById('gameOverFoundText');
            DOMElements.playAgainBtn = document.getElementById('playAgainBtn');

            // Verify all essential elements were found
             for (const key in DOMElements) {
                 // Check NodeLists separately
                 if (key === 'views') {
                     if (!DOMElements.views || DOMElements.views.length === 0) {
                         console.error(`UIManager Init Error: View elements not found!`);
                     }
                 } else if (!DOMElements[key]) {
                     console.error(`UIManager Init Error: Element with key "${key}" not found! Check HTML IDs.`);
                 }
             }
        },

        /** Shows the specified view and hides others. */
        showView: function(viewIdToShow) {
            activeViewId = viewIdToShow; // Update tracked view
            console.log("Showing view:", viewIdToShow);
            DOMElements.views.forEach(view => {
                const isActive = view.id === viewIdToShow;
                view.classList.toggle('active', isActive);
                view.classList.toggle('hidden', !isActive);
                // Special handling for modal flex display
                if (view.id === VIEW_IDS.HOW_TO_PLAY) {
                    view.classList.toggle('flex', isActive);
                }
            });
        },

        /** Formats seconds into MM:SS. */
        formatTime: function(totalSeconds) {
            const seconds = Math.max(0, Math.floor(totalSeconds));
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
        },

        /** Renders a list of players with status indicators. Uses client-side constants. */
        _renderPlayerList: function(listElement, players, myId, isFinal = false, activeUnfoundId = null) {
            if (!listElement) return;
            listElement.innerHTML = ''; // Clear previous list

            Object.values(players || {})
                .sort((a, b) => a.number - b.number)
                .forEach(player => {
                    const li = document.createElement('li');
                    li.classList.add('text-lg', 'p-1', 'rounded');

                    let content = `Phone ${player.number}`; // Base content

                    // Status indicators for Seeking/Game Over
                    if (isFinal) { // Game Over List
                        if (player.isFound) {
                            content += ' <span class="text-green-400">Found ✅</span>';
                        } else {
                            content += ' <span class="text-red-400">Not Found ❌</span>';
                            if (player.id === activeUnfoundId) {
                                li.classList.add('bg-yellow-800', 'font-bold', 'animate-pulse');
                                content += ' <span class="text-yellow-300">(Playing Sound...)</span>';
                            }
                        }
                    } else if (currentRoomState?.gameState === GAME_STATE.SEEKING) { // Seeking List
                         if (player.isFound) {
                            content += ': <span class="text-green-400">✅ Found</span>';
                        } else {
                            content += ': <span class="text-gray-400">❓ Hidden</span>';
                        }
                    }

                    // Highlight self in waiting room without adding text
                    if (player.id === myId && !isFinal) {
                        li.classList.add('ring-1', 'ring-teal-400');
                    }

                    li.innerHTML = content;
                    listElement.appendChild(li);
            });
        },

        /** Updates the timer display during Seeking phase. Uses client-side constants. */
        updateTimerDisplay: function() {
            const state = currentRoomState;
            // Use client-side GAME_STATE constant
            if (state && state.gameState === GAME_STATE.SEEKING && state.seekStartTime) {
                const elapsedSeconds = (Date.now() - state.seekStartTime) / 1000;
                const remainingSeconds = state.seekTimeLimit - elapsedSeconds;
                DOMElements.timerDisplay.textContent = this.formatTime(remainingSeconds);

                if (remainingSeconds <= 0 && seekTimerInterval) {
                    clearInterval(seekTimerInterval);
                    seekTimerInterval = null;
                    DOMElements.timerDisplay.textContent = "00:00";
                }
            } else {
                if (seekTimerInterval) { clearInterval(seekTimerInterval); seekTimerInterval = null; }
                DOMElements.timerDisplay.textContent = this.formatTime(state?.seekTimeLimit || 0);
            }
        },

        /** Updates the UI for the Waiting Room view. Uses client-side constants. */
        updateWaitingRoomUI: function(state) {
            DOMElements.roomCodeDisplay.textContent = state.roomCode;
            DOMElements.seekTimeLimitInput.value = state.seekTimeLimit;
            // Use state value if available, otherwise default from client-side constants
            DOMElements.soundPlaysInput.value = state.soundPlaysPerPlayer ?? DEFAULT_SOUND_PLAYS_PER_PLAYER;

            this._renderPlayerList(DOMElements.playerList, state.players, myPlayerId);

            const myPlayerData = state.players[myPlayerId];
            // Use client-side PLAYER_ROLE constant
            const amIHider = myPlayerData?.role === PLAYER_ROLE.HIDER;

            DOMElements.hiderControls.classList.toggle('hidden', !amIHider);

            if (amIHider) {
                // Use client-side MIN_PLAYERS_TO_START if needed, though logic relies on length check
                const canStart = Object.keys(state.players).length >= 2; // Assuming MIN_PLAYERS_TO_START is 2
                DOMElements.startHidingBtn.disabled = !canStart;
                this.showError(canStart ? '' : 'Waiting for more players...', DOMElements.startError, 0); // Clear error if can start
            } else {
                 this.showError('', DOMElements.startError, 0); // Clear error if not hider
            }

            // Reset elements from other views
            DOMElements.hidingCountdown.textContent = '-';
            DOMElements.timerDisplay.textContent = this.formatTime(state.seekTimeLimit);
            DOMElements.playAgainBtn.classList.add('hidden');
            DOMElements.hiderWinRevealSection.classList.add('hidden');
            this.clearError(DOMElements.joinError); // Clear join error when entering waiting room
        },

        /** Updates the UI for the Hiding Phase view. */
        updateHidingPhaseUI: function(state) {
            const myPlayerData = state.players[myPlayerId];
            let readyCount = 0;
            Object.values(state.players).forEach(p => { if (p.isReady) readyCount++; });

            DOMElements.hidingStatus.textContent = `(${readyCount}/${Object.keys(state.players).length} phones confirmed hidden)`;

            const isClientReady = myPlayerData?.isReady;
            DOMElements.confirmHiddenBtn.classList.toggle('hidden', !!isClientReady);
            DOMElements.hidingConfirmedText.classList.toggle('hidden', !isClientReady);
            // Countdown display handled by 'preSeekCountdown' event
        },

         /** Updates the pre-seek countdown display. */
        updatePreSeekCountdown: function(value) {
             if (activeViewId === VIEW_IDS.HIDING) { // Only update if view is active
                const displayValue = value > 0 ? value : "0";
                DOMElements.hidingCountdown.textContent = displayValue;
                const isPulsing = value <= 3 && value > 0;
                DOMElements.hidingCountdown.classList.toggle('pulse', isPulsing);
                DOMElements.hidingCountdown.classList.toggle('text-red-600', isPulsing);
            }
        },

        /** Updates the UI for the Seeking Phase view. Uses client-side constants. */
        updateSeekingPhaseUI: function(state) {
            this._renderPlayerList(DOMElements.hiderStatusList, state.players, myPlayerId);

            // Use client-side GAME_STATE constant
            if (!seekTimerInterval && state.gameState === GAME_STATE.SEEKING && state.seekStartTime) {
                this.updateTimerDisplay(); // Initial update
                seekTimerInterval = setInterval(() => this.updateTimerDisplay(), 1000);
            } else if (!state.seekStartTime) {
                DOMElements.timerDisplay.textContent = this.formatTime(state.seekTimeLimit);
            }

            const myPlayerData = state.players[myPlayerId];
            const isClientFound = myPlayerData?.isFound;
            DOMElements.hiddenDeviceUi.classList.toggle('hidden', !!isClientFound);
            DOMElements.alreadyFoundText.classList.toggle('hidden', !isClientFound);
        },

        /** Updates the UI for the Game Over view. Uses client-side constants. */
        updateGameOverUI: function(state) {
            this._renderPlayerList(DOMElements.finalPlayerList, state.players, myPlayerId, true, state.activeUnfoundPlayerId);

            // Use client-side WINNER_TYPE constants
            if (state.winner === WINNER_TYPE.SEEKERS) {
                DOMElements.gameResult.textContent = 'Seekers Win!';
                DOMElements.gameResult.className = 'text-3xl font-semibold text-green-400';
                DOMElements.gameOverReason.textContent = 'All phones were found before time ran out.';
                DOMElements.hiderWinRevealSection.classList.add('hidden');
            } else if (state.winner === WINNER_TYPE.HIDER) {
                DOMElements.gameResult.textContent = 'Hider Wins!';
                DOMElements.gameResult.className = 'text-3xl font-semibold text-red-400';
                DOMElements.gameOverReason.textContent = 'Time ran out before all phones were found.';
                DOMElements.hiderWinRevealSection.classList.remove('hidden');

                const myPlayerData = state.players[myPlayerId];
                const amIActiveUnfound = state.activeUnfoundPlayerId === myPlayerId;
                const isClientFound = myPlayerData?.isFound;

                if (state.activeUnfoundPlayerId) {
                    DOMElements.hiderWinStatus.textContent = `Finding remaining phones...`;
                    DOMElements.hiderWinStatus.className = 'text-xl text-yellow-300';
                } else {
                    DOMElements.hiderWinStatus.textContent = 'All remaining phones revealed!';
                    DOMElements.hiderWinStatus.className = 'text-xl text-green-400';
                    AudioManager.stopUnfoundSoundLoop(); // Stop loop when naturally finished
                }

                DOMElements.markFoundGameOverBtn.classList.toggle('hidden', !!isClientFound || !amIActiveUnfound);
                DOMElements.gameOverFoundText.classList.toggle('hidden', !isClientFound);

            } else {
                DOMElements.gameResult.textContent = 'Game Over';
                DOMElements.gameResult.className = 'text-3xl font-semibold text-gray-400';
                DOMElements.gameOverReason.textContent = 'The game ended unexpectedly.';
                DOMElements.hiderWinRevealSection.classList.add('hidden');
                AudioManager.stopUnfoundSoundLoop();
            }
            DOMElements.playAgainBtn.classList.remove('hidden');
        },

        /** Shows an error message in a specified element, optionally clearing after delay. */
        showError: function(message, element, clearDelayMs = 5000) {
            if (element) {
                element.textContent = message;
                 // Clear the error message after a delay if specified
                 if (message && clearDelayMs > 0) {
                     setTimeout(() => {
                         // Check if the message is still the same before clearing
                         if (element.textContent === message) {
                             element.textContent = '';
                         }
                     }, clearDelayMs);
                 }
            } else {
                // Fallback alert if no specific element provided for current view
                console.error("Error Display Element not found for message:", message);
                alert(`Error: ${message}`); // Use alert as last resort
            }
        },

        /** Clears the text content of an error element immediately. */
        clearError: function(element) {
             if (element) {
                 element.textContent = '';
             }
        },

        /** Updates UI immediately on user action for better responsiveness. */
        handleConfirmHiddenClick: function() {
             DOMElements.confirmHiddenBtn.classList.add('hidden');
             DOMElements.hidingConfirmedText.classList.remove('hidden');
        },

        handleMarkSelfFoundClick: function() {
             DOMElements.hiddenDeviceUi.classList.add('hidden');
             DOMElements.alreadyFoundText.classList.remove('hidden');
             AudioManager.play(SOUND_URLS.FOUND, 'found'); // Play found sound locally immediately
        },

        handleMarkFoundGameOverClick: function() {
             AudioManager.stopUnfoundSoundLoop(); // Stop the reveal sound immediately
             DOMElements.markFoundGameOverBtn.classList.add('hidden');
             DOMElements.gameOverFoundText.classList.remove('hidden');
             AudioManager.play(SOUND_URLS.FAIL, 'fail'); // Play the 'fail' sound
        }
    };

    // =========================================================================
    // == Socket Client
    // =========================================================================
    const SocketClient = {
        socket: null,

        /** Initialize Socket.IO connection and base event listeners. */
        init: function() {
            console.log("SocketClient: Initializing connection...");
            // Ensure Socket.IO library is loaded
            if (typeof io === 'undefined') {
                 console.error("Socket.IO client library not found. Ensure it's included in the HTML.");
                 UIManager.showError("Connection library failed to load. Please refresh.", DOMElements.joinError);
                 return;
            }
            this.socket = io();
            this.setupEventListeners();
        },

        /** Set up listeners for core Socket.IO events and custom game events. */
        setupEventListeners: function() {
            this.socket.on('connect', this.handleConnect.bind(this));
            this.socket.on('disconnect', this.handleDisconnect.bind(this));
            this.socket.on('errorMsg', this.handleErrorMsg.bind(this));
            this.socket.on('updateState', this.handleUpdateState.bind(this));
            this.socket.on('preSeekCountdown', this.handlePreSeekCountdown.bind(this));
            this.socket.on('playSound', this.handlePlaySound.bind(this));
            this.socket.on('becomeActiveUnfound', this.handleBecomeActiveUnfound.bind(this));
            this.socket.on('playVictoryMelody', this.handlePlayVictoryMelody.bind(this));
        },

        // --- Event Handlers ---

        handleConnect: function() {
            console.log('Connected to server. Socket ID:', this.socket.id);
            myPlayerId = this.socket.id;
            // If not already in a game (e.g., fresh load or after disconnect error), ensure Join view
            if (!currentRoomState) {
                 UIManager.showView(VIEW_IDS.JOIN);
            }
        },

        handleDisconnect: function(reason) {
            console.warn('Disconnected from server:', reason);
            AudioManager.resetState(); // Stop sounds, clear audio state

            // Use client-side GAME_STATE constants
            const wasInGame = currentRoomState && currentRoomState.gameState !== GAME_STATE.WAITING && currentRoomState.gameState !== GAME_STATE.GAME_OVER;

            // Clear local state and timers
            currentRoomState = null;
            myPlayerId = null;
            if (seekTimerInterval) clearInterval(seekTimerInterval);
            seekTimerInterval = null;

            // Show Join view and potentially an error message
            UIManager.showView(VIEW_IDS.JOIN);
            if (wasInGame && reason !== 'io client disconnect') { // Don't show error for manual leave
                 UIManager.showError('Connection lost. Please rejoin or create a new game.', DOMElements.joinError);
            } else {
                 UIManager.clearError(DOMElements.joinError); // Clear any previous errors on normal disconnect/leave
            }
        },

        handleErrorMsg: function(message) {
            console.error('Server Error Message:', message);
            // Determine the correct error element based on the active view
            let errorElement = null;
            switch (activeViewId) {
                case VIEW_IDS.JOIN:         errorElement = DOMElements.joinError; break;
                case VIEW_IDS.WAITING_ROOM: errorElement = DOMElements.startError; break;
                // Add cases for other views if they need specific error displays
                default: console.warn("No specific error element found for active view:", activeViewId);
            }
             UIManager.showError(message, errorElement); // UIManager handles fallback alert
        },

        handleUpdateState: function(state) {
            console.log('Received state update:', state.gameState, state);
            const previousState = currentRoomState?.gameState;
            currentRoomState = state; // Update local state *first*

            // --- Audio Preloading ---
            // Use client-side GAME_STATE constants
            if ((state.gameState === GAME_STATE.WAITING || state.gameState === GAME_STATE.HIDING) && !soundsPreloaded && audioContextStarted) {
                AudioManager.preloadGameSounds(state.players);
            }

             // --- Reset Audio on New Game ---
             // Use client-side GAME_STATE constants
             if (state.gameState === GAME_STATE.WAITING && previousState === GAME_STATE.GAME_OVER) {
                 AudioManager.resetState();
                 if (audioContextStarted) { // Preload immediately if possible
                      AudioManager.preloadGameSounds(state.players);
                 }
             }

            // --- Clear Intervals/Stop Sounds Based on State Transitions ---
            // Use client-side GAME_STATE constant
            if (state.gameState !== GAME_STATE.SEEKING && seekTimerInterval) {
                clearInterval(seekTimerInterval);
                seekTimerInterval = null;
            }
            // Stop unfound loop unless specifically active
            // Use client-side GAME_STATE and WINNER_TYPE constants
            if (!(state.gameState === GAME_STATE.GAME_OVER && state.winner === WINNER_TYPE.HIDER && state.activeUnfoundPlayerId === myPlayerId)) {
                 AudioManager.stopUnfoundSoundLoop();
            }
            // Stop seeking sounds when leaving Seeking state
            // Use client-side GAME_STATE constant
            if (previousState === GAME_STATE.SEEKING && state.gameState !== GAME_STATE.SEEKING) {
                AudioManager.stopAllSeekingSounds();
            }

            // --- Update UI Based on New Game State ---
            // Use client-side GAME_STATE constants
            switch (state.gameState) {
                case GAME_STATE.WAITING:
                    UIManager.showView(VIEW_IDS.WAITING_ROOM);
                    UIManager.updateWaitingRoomUI(state);
                    break;
                case GAME_STATE.HIDING:
                    UIManager.showView(VIEW_IDS.HIDING);
                    UIManager.updateHidingPhaseUI(state);
                    break;
                case GAME_STATE.SEEKING:
                    UIManager.showView(VIEW_IDS.SEEKING);
                    UIManager.updateSeekingPhaseUI(state);
                    break;
                case GAME_STATE.GAME_OVER:
                    UIManager.showView(VIEW_IDS.GAME_OVER);
                    UIManager.updateGameOverUI(state);
                    break;
                default:
                    console.warn("Unknown game state received:", state.gameState, ". Resetting to Join view.");
                    AudioManager.stopUnfoundSoundLoop();
                    UIManager.showView(VIEW_IDS.JOIN);
                    break;
            }
        },

        handlePreSeekCountdown: function(value) {
             UIManager.updatePreSeekCountdown(value);
        },

        handlePlaySound: function(profile) {
            if (currentRoomState?.players[myPlayerId] && !currentRoomState.players[myPlayerId].isFound) {
                AudioManager.play(profile.soundURL, 'seeking');
            }
        },

        handleBecomeActiveUnfound: function(profile) {
            console.log('Received becomeActiveUnfound request:', profile.soundURL);
            AudioManager.stopAllSeekingSounds(); // Ensure seeking sounds stopped
            // UI update for button visibility handled by updateGameOverUI via state update
            AudioManager.startUnfoundSoundLoop(profile.soundURL);
        },

        handlePlayVictoryMelody: function() {
            console.log('Received playVictoryMelody request.');
            AudioManager.stopAllSeekingSounds();
            AudioManager.stopUnfoundSoundLoop();
            AudioManager.play(SOUND_URLS.VICTORY, 'victory');
        },

        // --- Emitters ---

        emitJoinRoom: function(code) {
            this.socket.emit('joinRoom', code);
        },
        emitCreateRoom: function() {
            this.socket.emit('createRoom');
        },
         emitLeaveRoom: function() {
             this.socket.emit('leaveRoom');
         },
        emitUpdateSettings: function(settings) {
            this.socket.emit('updateSettings', settings);
        },
        emitStartHiding: function() {
            this.socket.emit('startHiding');
        },
        emitConfirmHidden: function() {
            this.socket.emit('confirmHidden');
        },
        emitMarkSelfFound: function() {
            this.socket.emit('markSelfFound');
        },
        emitRequestPlayAgain: function() {
            this.socket.emit('requestPlayAgain');
        }
    };

    // =========================================================================
    // == Main Application Logic & Event Listeners
    // =========================================================================
    function setupUIEventListeners() {
        console.log("Setting up UI event listeners.");

        // --- Modal ---
        DOMElements.howToPlayBtn.addEventListener('click', () => {
            UIManager.showView(VIEW_IDS.HOW_TO_PLAY);
        });
        DOMElements.closeHowToPlayBtn.addEventListener('click', () => {
            // Return to the view that was active before opening the modal
            UIManager.showView(activeViewId === VIEW_IDS.HOW_TO_PLAY ? VIEW_IDS.JOIN : activeViewId);
        });

        // --- Join View ---
        DOMElements.joinRoomBtn.addEventListener('click', () => {
            AudioManager.attemptStart(); // Crucial: Start audio on first interaction
            const code = DOMElements.roomCodeInput.value.trim().toUpperCase();
            // Use client-side ROOM_CODE_LENGTH constant
            if (code.length === ROOM_CODE_LENGTH) {
                UIManager.clearError(DOMElements.joinError);
                SocketClient.emitJoinRoom(code);
            } else {
                UIManager.showError(`Room code must be ${ROOM_CODE_LENGTH} characters.`, DOMElements.joinError);
            }
        });

        DOMElements.createRoomBtn.addEventListener('click', () => {
            AudioManager.attemptStart(); // Crucial: Start audio on first interaction
            UIManager.clearError(DOMElements.joinError);
            SocketClient.emitCreateRoom();
        });

         // Input validation for room code
         DOMElements.roomCodeInput.addEventListener('input', () => {
             DOMElements.roomCodeInput.value = DOMElements.roomCodeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
             // Use client-side ROOM_CODE_LENGTH constant
             if (DOMElements.roomCodeInput.value.length > ROOM_CODE_LENGTH) {
                 DOMElements.roomCodeInput.value = DOMElements.roomCodeInput.value.slice(0, ROOM_CODE_LENGTH);
             }
         });

        // --- Waiting Room View ---
        DOMElements.updateSettingsBtn.addEventListener('click', () => {
            const timeLimit = parseInt(DOMElements.seekTimeLimitInput.value, 10);
            const soundPlays = parseInt(DOMElements.soundPlaysInput.value, 10);

            // Basic client-side validation using client-side constants
            let errorMsg = '';
            if (isNaN(timeLimit) || timeLimit < MIN_SEEK_TIME_LIMIT_S || timeLimit > MAX_SEEK_TIME_LIMIT_S) {
                 errorMsg = `Time limit must be ${MIN_SEEK_TIME_LIMIT_S}-${MAX_SEEK_TIME_LIMIT_S}s.`;
            } else if (isNaN(soundPlays) || soundPlays < MIN_SOUND_PLAYS || soundPlays > MAX_SOUND_PLAYS) {
                 errorMsg = `Sounds/phone must be ${MIN_SOUND_PLAYS}-${MAX_SOUND_PLAYS}.`;
            }

            if (errorMsg) {
                UIManager.showError(errorMsg, DOMElements.startError);
            } else {
                UIManager.clearError(DOMElements.startError);
                SocketClient.emitUpdateSettings({
                    seekTimeLimit: timeLimit,
                    soundPlaysPerPlayer: soundPlays
                });
            }
        });

        DOMElements.startHidingBtn.addEventListener('click', () => {
            UIManager.clearError(DOMElements.startError);
            SocketClient.emitStartHiding();
        });

        DOMElements.backToJoinBtn.addEventListener('click', () => {
            console.log("Back button clicked.");
            SocketClient.emitLeaveRoom(); // Tell server we are leaving
            UIManager.showView(VIEW_IDS.JOIN); // Immediately switch view locally
            // Clear local state to prevent issues
            currentRoomState = null;
            // Keep player ID if socket still connected, otherwise null
            myPlayerId = SocketClient.socket?.id || null;
            if (seekTimerInterval) clearInterval(seekTimerInterval); // Clear timer if running
            seekTimerInterval = null;
            AudioManager.resetState(); // Reset audio state as well
        });

        // --- Hiding Phase View ---
        DOMElements.confirmHiddenBtn.addEventListener('click', () => {
            UIManager.handleConfirmHiddenClick(); // Immediate UI update
            SocketClient.emitConfirmHidden(); // Inform server
        });

        // --- Seeking Phase View ---
        DOMElements.markSelfFoundBtn.addEventListener('click', () => {
            UIManager.handleMarkSelfFoundClick(); // Immediate UI update + sound
            SocketClient.emitMarkSelfFound(); // Inform server
        });

        // --- Game Over View ---
        DOMElements.markFoundGameOverBtn.addEventListener('click', () => {
            UIManager.handleMarkFoundGameOverClick(); // Immediate UI update + sound
            SocketClient.emitMarkSelfFound(); // Inform server (same event)
        });

        DOMElements.playAgainBtn.addEventListener('click', () => {
            AudioManager.resetState(); // Reset audio state locally first
            SocketClient.emitRequestPlayAgain(); // Request server reset
        });
    }

    // --- App Initialization ---
    function initializeApp() {
        console.log("Hide 'n' Seek: Initializing application...");
        UIManager.init(); // Cache DOM elements first
        SocketClient.init(); // Start socket connection
        setupUIEventListeners(); // Setup button clicks etc.
        UIManager.showView(VIEW_IDS.JOIN); // Start at the join view
        console.log("Application initialized. Waiting for server connection and user interaction.");
    }

    // Start the application once the DOM is fully loaded
    document.addEventListener('DOMContentLoaded', initializeApp);

})(); // End IIFE

