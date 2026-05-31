const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Game Config
const DEPTH_SPEED_PER_PHASE = { 1: 5, 2: 10, 3: 15, 4: 25 }; // meters per tick (1 tick = 1 sec)
const TASK_INTERVAL_PER_PHASE = { 1: 10, 2: 7, 3: 5, 4: 4 }; // seconds between tasks
const TASK_DURATION_PER_PHASE = { 1: 15000, 2: 12000, 3: 9000, 4: 7000 }; // ms allowed per task

const ROLES = [
  'Engine Room',
  'Sonar Room',
  'Pressure Room',
  'Oxygen Room'
];

// Controls definitions mapped to roles
const CONTROLS_BY_ROLE = {
  'Engine Room': [
    { id: 'power_switch_1', name: 'Power Grid Grid-A', type: 'toggle', targetText: 'FLIP POWER GRID A ON', successValue: true },
    { id: 'power_switch_2', name: 'Power Grid Grid-B', type: 'toggle', targetText: 'FLIP POWER GRID B ON', successValue: true },
    { id: 'power_switch_3', name: 'Auxiliary Generator Switch', type: 'toggle', targetText: 'ENGAGE AUXILIARY SWITCH', successValue: true },
    { id: 'coolant_valve', name: 'Reactor Coolant Flow', type: 'slider', targetText: 'ADJUST REACTOR COOLANT TO [VAL]%', range: [20, 80], tolerance: 5 },
    { id: 'fuel_battery', name: 'Main Power Battery Cell', type: 'slider', targetText: 'SET FUEL BATTERY CELL TO [VAL]%', range: [10, 90], tolerance: 5 },
    { id: 'dynamo_crank', name: 'Manual Dynamo', type: 'crank', targetText: 'CRANK DYNAMO TO [VAL] RPM', range: [50, 90], tolerance: 5 }
  ],
  'Sonar Room': [
    { id: 'radar_frequency', name: 'Sonar Sweep Frequency', type: 'slider', targetText: 'TUNE SONAR TO [VAL] kHz', range: [15, 95], tolerance: 4 },
    { id: 'pinger_button', name: 'Sonar Pulse Pinger', type: 'button', targetText: 'FIRE SONAR PULSE PINGER', successValue: true },
    { id: 'depth_scanner', name: 'Lidar Scanner Gain', type: 'slider', targetText: 'ADJUST LIDAR SCANNER TO [VAL]%', range: [30, 80], tolerance: 5 },
    { id: 'coordinate_input', name: 'Vector Coordinates', type: 'code', targetText: 'ENTER VECTOR COORDINATES [VAL]', codes: ['A3', 'B7', 'X9', 'Z1', 'E5', 'H8'] }
  ],
  'Pressure Room': [
    { id: 'ballast_valve', name: 'Main Ballast Exhaust', type: 'toggle', targetText: 'OPEN BALLAST EXHAUST VALVE', successValue: true },
    { id: 'pressure_release_1', name: 'Equalizer Pressure Valve 1', type: 'toggle', targetText: 'OPEN PRESSURE EQUALIZER 1', successValue: true },
    { id: 'pressure_release_2', name: 'Equalizer Pressure Valve 2', type: 'toggle', targetText: 'OPEN PRESSURE EQUALIZER 2', successValue: true },
    { id: 'hull_weld_button', name: 'Emergency Hull Welder', type: 'hold', targetText: 'HOLD DOWN EMERGENCY HULL WELDER', successValue: true }
  ],
  'Oxygen Room': [
    { id: 'o2_scrubber_1', name: 'Carbon Filter Scrubber 1', type: 'toggle', targetText: 'ACTIVATE CARBON SCRUBBER 1', successValue: true },
    { id: 'o2_scrubber_2', name: 'Carbon Filter Scrubber 2', type: 'toggle', targetText: 'ACTIVATE CARBON SCRUBBER 2', successValue: true },
    { id: 'ventilation_toggle', name: 'Airlock Ventilation Fan', type: 'toggle', targetText: 'TOGGLE AIRLOCK VENTILATION ON', successValue: true },
    { id: 'o2_flow_slider', name: 'Oxygen Flow Rate', type: 'slider', targetText: 'SET OXYGEN FLOW RATE TO [VAL]%', range: [40, 90], tolerance: 5 }
  ]
};

// Rooms DB
const rooms = {};

// Helper: Alphanumeric Room Code generator
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[code] ? generateRoomCode() : code;
}

// Helper: Broadcast state to all players in a room
function broadcastToRoom(roomCode, data) {
  const room = rooms[roomCode];
  if (!room) return;
  const json = JSON.stringify(data);
  room.players.forEach(p => {
    if (p.socket && p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(json);
    }
  });
}

// Helper: Send event to specific player
function sendToPlayer(player, data) {
  if (player.socket && player.socket.readyState === WebSocket.OPEN) {
    player.socket.send(JSON.stringify(data));
  }
}

// Starts the core game logic and sync ticking
function startGame(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.isStarted) return;

  room.isStarted = true;
  room.depth = 0;
  room.health = 100;
  room.oxygen = 100;
  room.pressure = 20;
  room.phase = 1;
  room.tasks = [];
  room.globalEvent = null;
  room.taskCounter = 0;
  room.taskTimerAccumulator = 0;
  room.hazardTimerAccumulator = 0;

  // Auto assign roles
  // 4 Roles: Engine Room, Sonar Room, Pressure Room, Oxygen Room
  const activePlayers = room.players;
  const numPlayers = activePlayers.length;

  if (numPlayers >= 4) {
    // 1 role each (cap at 4)
    for (let i = 0; i < 4; i++) {
      activePlayers[i].roles = [ROLES[i]];
    }
  } else if (numPlayers === 3) {
    // Player 0 gets 2 roles, others get 1
    activePlayers[0].roles = [ROLES[0], ROLES[3]]; // Engine + Oxygen
    activePlayers[1].roles = [ROLES[1]]; // Sonar
    activePlayers[2].roles = [ROLES[2]]; // Pressure
  } else if (numPlayers === 2) {
    // 2 roles each
    activePlayers[0].roles = [ROLES[0], ROLES[1]]; // Engine + Sonar
    activePlayers[1].roles = [ROLES[2], ROLES[3]]; // Pressure + Oxygen
  } else {
    // Single player — only their own room
    activePlayers[0].roles = [ROLES[0]]; // Engine Room only
  }

  broadcastToRoom(roomCode, {
    type: 'game_start',
    rolesAssignment: activePlayers.map(p => ({ playerId: p.id, name: p.name, roles: p.roles }))
  });

  // Start ticking game states
  room.gameLoopInterval = setInterval(() => {
    tickGame(roomCode);
  }, 1000);
}

function tickGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // 1. Increment depth & update phases
  const currentSpeed = DEPTH_SPEED_PER_PHASE[room.phase];
  room.depth += currentSpeed;

  if (room.depth >= 3000) {
    room.phase = 4; // Collapse
  } else if (room.depth >= 1800) {
    room.phase = 3; // Panic
  } else if (room.depth >= 800) {
    room.phase = 2; // Stress
  } else {
    room.phase = 1; // Calm
  }

  // 2. Adjust oxygen & pressure
  // Oxygen slowly depletes if any oxygen tasks are failed. Basic constant drain:
  room.oxygen = Math.max(0, room.oxygen - 0.2);
  // Pressure slowly builds up naturally in deep water
  room.pressure = Math.min(100, room.pressure + (0.1 * room.phase));

  // 3. Process Active Tasks timers
  const now = Date.now();
  const activeTasks = [];

  for (let task of room.tasks) {
    if (now >= task.expiresAt) {
      // Task Expired! Penalty
      room.health = Math.max(0, room.health - 12);
      room.oxygen = Math.max(0, room.oxygen - 8);
      room.pressure = Math.min(100, room.pressure + 10);

      broadcastToRoom(roomCode, {
        type: 'task_failed',
        taskId: task.id,
        penaltyText: `SYSTEM FAILURE: ${task.instruction} EXPIRED!`
      });
    } else {
      activeTasks.push(task);
    }
  }
  room.tasks = activeTasks;

  // 4. Generate random task periodically
  room.taskTimerAccumulator += 1;
  const currentTaskInterval = TASK_INTERVAL_PER_PHASE[room.phase];
  if (room.taskTimerAccumulator >= currentTaskInterval) {
    room.taskTimerAccumulator = 0;
    generateNewTask(roomCode);
  }

  // 5. Generate random hazard / incident periodically
  room.hazardTimerAccumulator += 1;
  // Trigger a hazard every 35 seconds (phase dependent)
  const hazardTriggerTime = room.phase === 4 ? 20 : 35;
  if (room.hazardTimerAccumulator >= hazardTriggerTime) {
    room.hazardTimerAccumulator = 0;
    triggerRandomHazard(roomCode);
  }

  // 6. Monitor game-over conditions
  if (room.health <= 0 || room.oxygen <= 0 || room.pressure >= 100) {
    let reason = "HULL COLLAPSED";
    if (room.oxygen <= 0) reason = "ASPHYXIATION (OXYGEN DEPLETED)";
    if (room.pressure >= 100) reason = "HYDROPNEUMATIC CRUSHING";

    broadcastToRoom(roomCode, {
      type: 'game_over',
      depth: room.depth,
      reason: reason
    });

    // Reset room
    clearInterval(room.gameLoopInterval);
    room.isStarted = false;
    room.players.forEach(p => p.ready = false);
    return;
  }

  // 7. Broadcast current game state
  sendGameState(roomCode);
}

// Generate an Asymmetric Task
function generateNewTask(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.players.length < 1) return;

  room.taskCounter++;
  const taskId = `task_${room.taskCounter}`;

  // 1. Pick a role that has at least one player assigned to it
  const activeRoles = [...new Set(room.players.flatMap(p => p.roles))];
  if (activeRoles.length === 0) return;
  const targetRole = activeRoles[Math.floor(Math.random() * activeRoles.length)];
  const possibleControls = CONTROLS_BY_ROLE[targetRole];
  const controlTemplate = possibleControls[Math.floor(Math.random() * possibleControls.length)];

  // Determine a random target value
  let targetValue;
  let label = controlTemplate.targetText;

  if (controlTemplate.type === 'toggle' || controlTemplate.type === 'button' || controlTemplate.type === 'hold') {
    targetValue = controlTemplate.successValue;
  } else if (controlTemplate.type === 'slider' || controlTemplate.type === 'crank') {
    const min = controlTemplate.range[0];
    const max = controlTemplate.range[1];
    // Generate step of 5
    targetValue = min + Math.floor(Math.random() * ((max - min) / 5 + 1)) * 5;
    label = label.replace('[VAL]', targetValue);
  } else if (controlTemplate.type === 'code') {
    targetValue = controlTemplate.codes[Math.floor(Math.random() * controlTemplate.codes.length)];
    label = label.replace('[VAL]', targetValue);
  }

  // Asymmetric Routing:
  // Receiver: The player holding this control role
  const receiverPlayer = room.players.find(p => p.roles.includes(targetRole)) || room.players[0];

  // Sender: Any player EXCEPT the receiver player (or same if only 1 player)
  let senderPlayer;
  const otherPlayers = room.players.filter(p => p.id !== receiverPlayer.id);
  if (otherPlayers.length > 0) {
    senderPlayer = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
  } else {
    senderPlayer = receiverPlayer;
  }

  const durationMs = TASK_DURATION_PER_PHASE[room.phase];

  const newTask = {
    id: taskId,
    senderId: senderPlayer.id,
    senderName: senderPlayer.name,
    receiverId: receiverPlayer.id,
    receiverRole: targetRole,
    controlId: controlTemplate.id,
    targetValue: targetValue,
    controlType: controlTemplate.type,
    tolerance: controlTemplate.tolerance,
    instruction: label, // "ADJUST REACTOR COOLANT TO 60%"
    expiresAt: Date.now() + durationMs,
    durationMs: durationMs
  };

  room.tasks.push(newTask);
}

// Generate hazard
function triggerRandomHazard(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.globalEvent) return;

  const hazards = ['SHOCKWAVE', 'BLACKOUT', 'ELECTRIC_SURGE', 'WATER_LEAK'];
  const chosenHazard = hazards[Math.floor(Math.random() * hazards.length)];

  if (chosenHazard === 'SHOCKWAVE') {
    // Shockwave: Everyone must shake
    room.globalEvent = {
      type: 'SHOCKWAVE',
      expiresAt: Date.now() + 5000, // 5 seconds to shake together
      shakenPlayers: []
    };
    broadcastToRoom(roomCode, {
      type: 'hazard_trigger',
      hazard: 'SHOCKWAVE',
      durationMs: 5000
    });

    // Set timer to validate shake completion
    setTimeout(() => {
      resolveShockwave(roomCode);
    }, 5000);
  } else {
    // Passive UI/Control hazard lasting 10-15 seconds
    const duration = chosenHazard === 'BLACKOUT' ? 10000 : 15000;
    room.globalEvent = {
      type: chosenHazard,
      expiresAt: Date.now() + duration
    };
    broadcastToRoom(roomCode, {
      type: 'hazard_trigger',
      hazard: chosenHazard,
      durationMs: duration
    });

    setTimeout(() => {
      if (room.globalEvent && room.globalEvent.type === chosenHazard) {
        room.globalEvent = null;
        broadcastToRoom(roomCode, {
          type: 'hazard_clear',
          hazard: chosenHazard
        });
      }
    }, duration);
  }
}

function resolveShockwave(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.globalEvent || room.globalEvent.type !== 'SHOCKWAVE') return;

  const numPlayers = room.players.length;
  const shakenCount = room.globalEvent.shakenPlayers.length;

  // For Co-op satisfaction, require at least 75% of players to shake
  const required = Math.ceil(numPlayers * 0.75);
  const success = shakenCount >= required;

  if (success) {
    room.health = Math.max(0, room.health - 2); // Small bump
    broadcastToRoom(roomCode, {
      type: 'hazard_clear',
      hazard: 'SHOCKWAVE',
      success: true,
      text: 'SHOCKWAVE STABILIZED! HULL INTACT.'
    });
  } else {
    // Disaster! Heavy damage
    room.health = Math.max(0, room.health - 30);
    room.pressure = Math.min(100, room.pressure + 15);
    room.oxygen = Math.max(0, room.oxygen - 10);

    broadcastToRoom(roomCode, {
      type: 'hazard_clear',
      hazard: 'SHOCKWAVE',
      success: false,
      text: 'SHOCKWAVE IMPACT! HEAVY DAMAGE SUSTAINED!'
    });

    // Immediately trigger blackout to add to the panic
    room.globalEvent = {
      type: 'BLACKOUT',
      expiresAt: Date.now() + 8000
    };
    broadcastToRoom(roomCode, {
      type: 'hazard_trigger',
      hazard: 'BLACKOUT',
      durationMs: 8000
    });
    setTimeout(() => {
      if (room.globalEvent && room.globalEvent.type === 'BLACKOUT') {
        room.globalEvent = null;
        broadcastToRoom(roomCode, { type: 'hazard_clear', hazard: 'BLACKOUT' });
      }
    }, 8000);
  }
}

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const statePayload = {
    type: 'state_update',
    depth: Math.floor(room.depth),
    health: Math.floor(room.health),
    oxygen: Math.floor(room.oxygen),
    pressure: Math.floor(room.pressure),
    phase: room.phase,
    globalEvent: room.globalEvent ? room.globalEvent.type : null,
    // Sanitize tasks for clients
    tasks: room.tasks.map(t => ({
      id: t.id,
      senderId: t.senderId,
      senderName: t.senderName,
      receiverId: t.receiverId,
      receiverRole: t.receiverRole,
      instruction: t.instruction,
      controlId: t.controlId,
      expiresAt: t.expiresAt,
      durationMs: t.durationMs
    }))
  };

  broadcastToRoom(roomCode, statePayload);
}

// Websocket Message Handlers
wss.on('connection', (ws) => {
  let playerRef = null;
  let roomRef = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'create_room': {
          const roomCode = generateRoomCode();
          const playerId = `player_${Math.random().toString(36).substr(2, 9)}`;

          playerRef = {
            id: playerId,
            name: data.playerName || 'Crew',
            roles: [],
            ready: false,
            socket: ws
          };

          rooms[roomCode] = {
            roomCode: roomCode,
            players: [playerRef],
            isStarted: false,
            gameLoopInterval: null
          };

          roomRef = rooms[roomCode];

          ws.send(JSON.stringify({
            type: 'room_created',
            roomCode: roomCode,
            playerId: playerId,
            players: [{ id: playerId, name: playerRef.name, ready: false }]
          }));
          break;
        }

        case 'join_room': {
          const code = (data.roomCode || '').toUpperCase();
          const room = rooms[code];
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Submarine Room code not found!' }));
            return;
          }

          if (room.isStarted) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game has already started in this submarine!' }));
            return;
          }

          if (room.players.length >= 4) {
            ws.send(JSON.stringify({ type: 'error', message: 'Crew limit reached! Maximum 4 players.' }));
            return;
          }

          const playerId = `player_${Math.random().toString(36).substr(2, 9)}`;
          playerRef = {
            id: playerId,
            name: data.playerName || `Crew ${room.players.length + 1}`,
            roles: [],
            ready: false,
            socket: ws
          };

          room.players.push(playerRef);
          roomRef = room;

          // Send confirmation to client
          ws.send(JSON.stringify({
            type: 'room_joined',
            roomCode: code,
            playerId: playerId,
            players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }))
          }));

          // Notify everyone else
          broadcastToRoom(code, {
            type: 'room_update',
            players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }))
          });
          break;
        }

        case 'player_ready': {
          if (!roomRef || !playerRef) return;
          playerRef.ready = data.ready;

          broadcastToRoom(roomRef.roomCode, {
            type: 'room_update',
            players: roomRef.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }))
          });

          // Check if all players are ready, start game
          const allReady = roomRef.players.every(p => p.ready);
          if (allReady && roomRef.players.length >= 1) { // Min 1 player (sandbox mode supported)
            startGame(roomRef.roomCode);
          }
          break;
        }

        case 'control_action': {
          if (!roomRef || !roomRef.isStarted) return;
          const { controlId, value } = data;

          // Verify if this interaction fulfills any active task
          const completedTasks = [];
          for (let task of roomRef.tasks) {
            if (task.controlId === controlId) {
              let isMatch = false;

              if (task.controlType === 'toggle' || task.controlType === 'button' || task.controlType === 'hold') {
                isMatch = (task.targetValue === value);
              } else if (task.controlType === 'slider' || task.controlType === 'crank') {
                const diff = Math.abs(task.targetValue - parseFloat(value));
                isMatch = (diff <= task.tolerance);
              } else if (task.controlType === 'code') {
                isMatch = (task.targetValue.toString().trim().toUpperCase() === value.toString().trim().toUpperCase());
              }

              if (isMatch) {
                completedTasks.push(task.id);
                // Mini reward: stabilize sub parameters slightly
                roomRef.health = Math.min(100, roomRef.health + 2);
                roomRef.pressure = Math.max(0, roomRef.pressure - 3);
              }
            }
          }

          if (completedTasks.length > 0) {
            // Remove completed tasks from loop
            roomRef.tasks = roomRef.tasks.filter(t => !completedTasks.includes(t.id));

            // Broadcast completion notification
            broadcastToRoom(roomRef.roomCode, {
              type: 'tasks_completed',
              taskIds: completedTasks
            });

            // Send game state update
            sendGameState(roomRef.roomCode);
          }
          break;
        }

        case 'shake': {
          if (!roomRef || !roomRef.isStarted || !roomRef.globalEvent) return;
          if (roomRef.globalEvent.type === 'SHOCKWAVE') {
            if (!roomRef.globalEvent.shakenPlayers.includes(playerRef.id)) {
              roomRef.globalEvent.shakenPlayers.push(playerRef.id);
              // Send acknowledge shake to user
              ws.send(JSON.stringify({ type: 'shake_ack' }));
            }
          }
          break;
        }
      }
    } catch (e) {
      console.error("Failed to parse incoming WS packet", e);
    }
  });

  ws.on('close', () => {
    if (roomRef && playerRef) {
      // Remove player
      roomRef.players = roomRef.players.filter(p => p.id !== playerRef.id);

      // If room is empty, kill the loop and delete the room
      if (roomRef.players.length === 0) {
        if (roomRef.gameLoopInterval) clearInterval(roomRef.gameLoopInterval);
        delete rooms[roomRef.roomCode];
      } else {
        // Notify others
        broadcastToRoom(roomRef.roomCode, {
          type: 'room_update',
          players: roomRef.players.map(p => ({ id: p.id, name: p.name, ready: p.ready }))
        });

        // If game was running, fail it/abort or handle disconnect scale
        if (roomRef.isStarted) {
          broadcastToRoom(roomRef.roomCode, {
            type: 'crew_disconnect',
            playerName: playerRef.name
          });

          // Scaled penalty: decrease health on disconnect
          roomRef.health = Math.max(0, roomRef.health - 25);
          sendGameState(roomRef.roomCode);
        }
      }
    }
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'ONLINE',
    activeSubmarines: Object.keys(rooms).length
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deep Dive Co-op WebSocket Server running on port ${PORT}`);
});
