"use strict";
var net = require('net');
var yaml = require('js-yaml');
var fs = require('fs');
var sockets = [];
var loginNames = {};  //Quickly find the user profile
var rooms = {};
var ESCAPE = String.fromCharCode(27);
var WORLD_INTERVAL = 200;
var cells = [];

var UserStateEnum = Object.freeze({
	"LOGIN" : 0,
	"LOBBY" : 1,
	"CHATROOM" : 2,
	"GAME" : 3
});

var PlayerStateEnum = Object.freeze({
	"IDLE" : 0,
	"ATTACK" : 1,
	"MOVED" : 2,
	"ESCAPING" : 3
});

var EnemyStateEnum = Object.freeze({
	"IDLE" : 0,
	"ATTACK" : 1
});

function CCellEntity(num){
	this.description = "";
	this.items = [];
	this.enemies = [];
	this.triggers = [];
	this.cellNum = num;
	this.playerNames = [];
	this.e_cell = null;
	this.w_cell = null;
	this.n_cell = null;
	this.s_cell = null;
	this.update = function(){
		//Remove nonexistent players
		for(var i in this.playerNames){
			if(findPlayer(this.playerNames[i]) === null){
				this.ejectPlayer(this.playerNames[i]);
			}
		}
		//Update enemies
		for(var i in this.enemies){
			this.enemies[i].update();
		}
	}
	this.ejectPlayer = function(playerName){
		this.playerNames = this.playerNames.filter(function(element){return element !== playerName;});
	}
}

function CPlayerEntity(socket){
	this.name = "";
	this.timeElapsed = 0;
	this.parentSocket = socket;
	this.cell = null;
	this.escaping_cell = null;
	this.hp = 50;
	this.weapon = null;
	this.items = [];
	this.state = PlayerStateEnum.IDLE;
	this.prev_state = PlayerStateEnum.IDLE;
	this.attacking = null;
	this.update = function(){
		if(this.state === PlayerStateEnum.IDLE){
			var hostileEnemies = findHostileEnemies(this);
			if(hostileEnemies.length !== 0){
				this.attacking = hostileEnemies[0];
				changeState(this, PlayerStateEnum.ATTACK);
			}
		}
		else if(this.state === PlayerStateEnum.MOVED){
			gameMsg(this.parentSocket, this.cell.description);
			gameMsg(this.parentSocket, availableMoves(this.cell));
			gameMsg(this.parentSocket, "players here : " + this.cell.playerNames);
			changeState(this, PlayerStateEnum.IDLE);
		}
		else if(this.state === PlayerStateEnum.ATTACK){
			this.timeElapsed += WORLD_INTERVAL;
			if(this.timeElapsed > 2500){
				if(this.attacking !== null){
					resolvePlayerAttack(this, this.attacking);
				}
				this.timeElapsed = 0;
			}
		}
		else if(this.state === PlayerStateEnum.ESCAPING){
			this.timeElapsed += WORLD_INTERVAL;
			if(this.timeElapsed > 2500){
				if(Math.random() > 0.7){
					moveToCell(this, this.escaping_cell);
					this.escaping_cell = null;
					gameMsg(this.parentSocket, fonts.highlight.output("You successfully fled"));
				}
				else{
					gameMsg(this.parentSocket, fonts.enemy.output("You failed to flee"));
					changeState(this, PlayerStateEnum.IDLE);
				}
				this.timeElapsed = 0;
			}
		}
	}
}

function findHostileEnemies(player){
	if(player !== null){
		return player.cell.enemies.filter(function(enemy){return enemy.attackingNamed === player.name;});
	}
	else{
		return [];
	}
}

function findHostilePlayerNames(enemy){
	return enemy.cell.playerNames.filter(function(playerName){
		var playerFound = findPlayer(playerName);
		if(playerFound !== null){			
			return playerFound.attacking === enemy;
		}
		else{
			return false;
		}
	});
}

function changeState(target, state){
	target.prev_state = target.state;
	target.state = state;
}

function CEnemyEntity(name){
	this.timeElapsed = 0;
	this.cell = null;
	this.hp = 0;
	this.dmg = 0;
	this.def = 0;
	this.attack_msg = "";
	this.drops = [];
	this.name = name;
	this.state = EnemyStateEnum.IDLE;
	this.prev_state = EnemyStateEnum.IDLE;
	this.attackingNamed = null;
	this.isDead = false;
	this.aggro = false;
	this.update = function(){
		if(this.state === EnemyStateEnum.IDLE){
			//Attack any hostile player first
			var hostilePlayerNames = findHostilePlayerNames(this);						
			if(hostilePlayerNames.length > 0){
				//Pick the first one on the list
				this.attackingNamed = hostilePlayerNames[0];
				changeState(this,  EnemyStateEnum.ATTACK);
			}
			else{
				//No hostile player. Pick any player to attack if it's aggro by default
				if(this.aggro){
					for(var i in this.cell.playerNames){
						var playerFound = findPlayer(this.cell.playerNames[i]);
						if(playerFound != null){
							this.attackingNamed = this.cell.playerNames[i];
							changeState(this,  EnemyStateEnum.ATTACK);
							gameMsg(playerFound.parentSocket, fonts.enemy.output(this.name) + " starts attacking YOU!");
							break;
						}					
					}
				}
			}
		}
		else if(this.state === EnemyStateEnum.ATTACK){
			this.timeElapsed += WORLD_INTERVAL;
			if(this.timeElapsed > 2500) {
				if (this.attackingNamed !== null) {
					var i = this.cell.playerNames.indexOf(this.attackingNamed);
					if (i != -1) {
						var playerFound = findPlayer(this.attackingNamed);
						if (playerFound !== null) {
							resolveEnemyAttack(this, playerFound);
						}
						else{
							changeState(this, EnemyStateEnum.IDLE);
							this.attackingNamed = null;
						}
					}
					else{
						changeState(this, EnemyStateEnum.IDLE);
						this.attackingNamed = null;
					}
				}
				else{
					changeState(this, EnemyStateEnum.IDLE);
				}
				this.timeElapsed = 0;
			}
		}
	}
}

function resolveEnemyAttack(enemy, player){
	player.hp -= enemy.dmg;
	gameMsg(player.parentSocket, fonts.enemy.output(enemy.name) + " " + enemy.attack_msg + ", causing " + fonts.damage.output(enemy.dmg.toString()) + " dmg (Your HP:" + player.hp.toString() + ")");
}

function resolvePlayerAttack(player, enemy){
	var dmg = 0;
	if(player.weapon === null){
		gameMsg(player.parentSocket, "You tried punching the " + enemy.name + " with your fist, but it hardly registered")
		dmg = 1;
	}
	else {
		dmg = player.weapon.dmg - enemy.def;
		if(player.weapon.name === "baseball_bat"){
			gameMsg(player.parentSocket, "You swang the baseball bat at " + fonts.enemy.output(enemy.name))
		}
		else if(player.weapon.name === "knife"){
			gameMsg(player.parentSocket, "You stabbed " + fonts.enemy.output(enemy.name) + " with your knife")
		}
		else if(player.weapon.name === "pistol"){
			gameMsg(player.parentSocket, "You fire the pistol at " + fonts.enemy.output(enemy.name) + ", and the bullet landed in the target")
		}
	}
	enemy.hp -= dmg;
	gameMsg(player.parentSocket, ", inflicting " + fonts.damage.output(dmg.toString()) + " dmg.");
}

function enemyParser(text, enemyDict){
	var searchIndex = text.search(/\(.+\)/);
	var count = 1;
	var name = "";
	if(searchIndex != -1){
		var left = text.search(/\(/);
		var right = text.search(/\)/);
		count = parseInt(text.substr(left + 1, right - left - 1));
		name = text.substr(0, left);
	}
	var arrayEnemies = [];
	for(var i = 0; i < count; i++){
		var newEnemy = new CEnemyEntity(name);
		newEnemy.hp = enemyDict[name].hp;
		newEnemy.dmg = enemyDict[name].dmg;
		newEnemy.def = enemyDict[name].def;
		if(enemyDict[name].aggro === 1){
			newEnemy.aggro = true;
		}
		newEnemy.attack_msg = enemyDict[name].attack_msg;
		for(var j in enemyDict[name].drops){
			newEnemy.drops.push(enemyDict[name].drops[j]);
		}
		arrayEnemies.push(newEnemy);
	}
	return arrayEnemies;
}

function CItemEntity(name){
	this.description = "";
	this.quantity = 1;
	this.name = name;
	var searchIndex = name.search(/\(.+\)/);
	if(searchIndex != -1){
		var left = name.search(/\(/);
		var right = name.search(/\)/);
		this.quantity = parseInt(name.substr(left + 1, right - left - 1));
		this.name = name.substr(0, left);
	}
}

function CTriggerEntity(name){
	this.name = name;
	this.description = "";
	function exitTrigger(player){
		player.cell.ejectPlayer(player.parentSocket.user_profile.name);
		player.parentSocket.user_profile.state = UserStateEnum.LOBBY;
		player.parentSocket.user_profile.room  = "";
	}
	if(name === "exit"){
		this.execute = exitTrigger;
		this.description = "The way out";
	}
}

function CUserProfile(){
	this.state = UserStateEnum.LOGIN;
	this.name = "";
	this.room = "";
}

var ColorCodesEnum = Object.freeze({
	"BLACK" : 0,
	"RED" : 1,
	"GREEN" : 2,
	"YELLOW" : 3,
	"BLUE" : 4,
	"MAGENTA" : 5,
	"CYAN" : 6,
	"WHITE" : 7,
	"BRIGHT_BLACK" : 8,
	"BRIGHT_RED" : 9,
	"BRIGHT_GREEN" : 10,
	"BRIGHT_YELLOW" : 11,
	"BRIGHT_BLUE" : 12,
	"BRIGHT_MAGENTA" : 13,
	"BRIGHT_CYAN" : 14,
	"BRIGHT_WHITE" : 15
});

function CColorFormatter(){
	this._color = ColorCodesEnum.WHITE;
	this._bgcolor = ColorCodesEnum.BLACK;
	this.color = function(code){
		this._color = code;
		return this;
	};
	this.bgColor = function(code){
		this._bgcolor = code;
		return this;
	};
	this.output = function(text) {
		return ESCAPE + "[38;5;" + this._color + "m" + ESCAPE + "[48;5;" + this._bgcolor + "m" + text + ESCAPE + "[0m";
	};
}

function CFonts(){
	this.system = new CColorFormatter();
	this.system.color(ColorCodesEnum.GREEN);
	this.highlight = new CColorFormatter();
	this.highlight.color(ColorCodesEnum.BRIGHT_WHITE);
	this.warning = new CColorFormatter();
	this.warning.color(ColorCodesEnum.BRIGHT_WHITE).bgColor(ColorCodesEnum.RED);
	this.enemy = new CColorFormatter();
	this.enemy.color(ColorCodesEnum.MAGENTA);
	this.damage = new CColorFormatter();
	this.damage.color(ColorCodesEnum.BRIGHT_RED);
}

var fonts = new CFonts();

function CGameWorld(){
	//Load the map
	try {
		//Read the raw map
		var cellMap = {};
		var mapArray = fs.readFileSync('map.txt').toString().split("\n");
		var nRows = parseInt(mapArray[0]) * 3;
		var nCols = parseInt(mapArray[1]) * 3;
		mapArray = mapArray.slice(2);
		for(var row in mapArray) {
			var innerArray = mapArray[row].split(",");
			mapArray[row] = [];
			for (var col in innerArray) {
				mapArray[row].push(parseInt(innerArray[col]));
			}
		}
		for(var row = 1; row < nRows - 1; row+=3){
			for(var col = 1; col < nCols - 1; col+=3){
				cellMap[mapArray[row][col]] = {};
				if(mapArray[row][col+1] === 1){
					cellMap[mapArray[row][col]].e_cell = mapArray[row][col+3];
				}
				if(mapArray[row][col-1] === 1){
					cellMap[mapArray[row][col]].w_cell = mapArray[row][col-3];
				}
				if(mapArray[row+1][col] === 1){
					cellMap[mapArray[row][col]].s_cell = mapArray[row+3][col];
				}
				if(mapArray[row-1][col] === 1){
					cellMap[mapArray[row][col]].n_cell = mapArray[row-3][col];
				}
			}
		}

		this.metamap = yaml.safeLoad(fs.readFileSync('metamap.yml', 'utf8'));
		for(var i in this.metamap.cells) {
			var newCell = new CCellEntity(this.metamap.cells[i].cell);
			newCell.description = this.metamap.cells[i].description;
			//Populate items
			if(this.metamap.cells[i].hasOwnProperty("items")){
				for(var j in this.metamap.cells[i].items){
					var newItem = new CItemEntity(this.metamap.cells[i].items[j]);
					newItem.description = this.metamap.items[newItem.name].description;
					newCell.items.push(newItem);
				}
			}
			//Populate enemies
			if(this.metamap.cells[i].hasOwnProperty("enemies")){
				for(var j in this.metamap.cells[i].enemies){
					Array.prototype.push.apply(newCell.enemies, enemyParser(this.metamap.cells[i].enemies[j], this.metamap.enemies).map(function(element){
						element.cell = newCell;
						return element;
					}));
				}
			}
			//Populate triggers
			if(this.metamap.cells[i].hasOwnProperty("triggers")){
				for(var j in this.metamap.cells[i].triggers){
					newCell.triggers.push(new CTriggerEntity(this.metamap.cells[i].triggers[j]));
				}
			}

			if(cellMap[newCell.cellNum].hasOwnProperty("e_cell")){
				newCell.e_cell = cellMap[newCell.cellNum].e_cell;
			}
			if(cellMap[newCell.cellNum].hasOwnProperty("w_cell")){
				newCell.w_cell = cellMap[newCell.cellNum].w_cell;
			}
			if(cellMap[newCell.cellNum].hasOwnProperty("s_cell")){
				newCell.s_cell = cellMap[newCell.cellNum].s_cell;
			}
			if(cellMap[newCell.cellNum].hasOwnProperty("n_cell")){
				newCell.n_cell = cellMap[newCell.cellNum].n_cell;
			}

			cells.push(newCell);
		}
	} catch (e) {
		console.log(e);
	}
	this.update = function(){
		//Cell action
		for(var i in cells){
			cells[i].update();
		}
		//Player action
		for(var i in sockets){
			if(sockets[i].user_profile.state === UserStateEnum.GAME){
				sockets[i].user_profile.playerEntity.update();
			}
		}
	}

}

function receiveData(socket, data){
	socket.buffer += data.toString();
	var searchIndex = socket.buffer.search(/(\r\n|\n|\r)/gm);
	if(searchIndex != -1)
	{
		processInput(socket, socket.buffer.slice(0, searchIndex));
		socket.buffer = socket.buffer.slice(searchIndex).replace(/(\r\n|\n|\r)/gm, "");
	}
}

function processInput(socket, inputStr){
	if(socket.user_profile.state === UserStateEnum.LOGIN){
		if(inputStr in loginNames){
			sendMsg(socket, 'Sorry, name taken.');
		}
		else{
			socket.user_profile.name = inputStr;
			socket.user_profile.state = UserStateEnum.LOBBY;
			loginNames[inputStr] = socket;
			sendMsg(socket, 'Welcome ' + inputStr + '!');
		}
	}
	else if(socket.user_profile.state === UserStateEnum.LOBBY){
		if(inputStr.match(/\/.+/))
		{
			processCommandLine(socket, inputStr.replace("/", ""));
		}
		else{
			broadcastMsg(socket.user_profile.name + ': ' + inputStr);
		}
	}
	else if(socket.user_profile.state === UserStateEnum.CHATROOM){
		if(inputStr.match(/\/.+/))
		{
			processCommandLine(socket, inputStr.replace("/", ""));
		}
		else{
			sendMsgRoom(socket.user_profile.room, socket.user_profile.name + ': ' + inputStr);
		}
	}
	else if(socket.user_profile.state === UserStateEnum.GAME){
		processGameCommand(socket, inputStr);
	}
}

function processCommandLine(socket, commandLine){
	var commands = commandLine.split(" ");
	var command = commands[0];
	if(command === "rooms"){
		sendMsg(socket, "Active rooms are:");
		for(var room in rooms){
			sendMsg(socket, "* " + fonts.highlight.output(room) + " (" + Object.keys(rooms[room]).length + ")");
		}
		sendMsg(socket, "end of list.");
	}
	else if(command === "join"){
		if(commands.length === 2) {
			var room = commands[1];
			leaveRoom(socket);
			if (!(room in rooms)) {
				rooms[room] = {};
			}
			rooms[room][socket.user_profile.name] = 0;
			socket.user_profile.room = room;
			socket.user_profile.state = UserStateEnum.CHATROOM;
			sendMsg(socket, "entering room: " + room);
			//List all users in chat room
			for(var i in Object.keys(rooms[room]))
			{
				var name = Object.keys(rooms[room])[i];
				if(socket.user_profile.name === name){
					sendMsg(socket, "* " + fonts.highlight.output(name) + " (** this is you)");
				}
				else{
					sendMsg(socket, fonts.highlight.output("* " + name));
				}
			}
			sendMsg(socket, "end of list.");
			enterRoomMsg(socket, room);
		}
		else{
			sendMsg(socket, "illegal number of parameters for /join");
		}
	}
	else if(command === "leave"){
		leaveRoom(socket);
	}
	else if(command === "quit"){
		sendMsg(socket, "BYE");
		closeSocket(socket);
		socket.destroy();
	}
	else if(command === "game"){
		gameMsg(socket, fonts.system.output("Entering game..."));
		socket.user_profile.state = UserStateEnum.GAME;
		socket.user_profile.playerEntity = new CPlayerEntity(socket);
		socket.user_profile.playerEntity.cell = cells[0]; //Initial cell
		socket.user_profile.playerEntity.name = socket.user_profile.name;
		socket.user_profile.playerEntity.cell.playerNames.push(socket.user_profile.name);
		changeState(socket.user_profile.playerEntity, PlayerStateEnum.MOVED);
	}
	else{
		sendMsg(socket, fonts.warning.output("Illegal command"));
	}
}

function processGameCommand(socket, commandLine){
	var commands = commandLine.split(" ");
	var command = commands[0];
	if(command === "quit"){
		gameMsg(socket, fonts.system.output("Quitting game..."));
		socket.user_profile.playerEntity.cell.playerNames = socket.user_profile.playerEntity.cell.playerNames.filter(function(playerName){return playerName !== socket.user_profile.name;});
		socket.user_profile.playerEntity.cell = null;		
		socket.user_profile.playerEntity.attacking = null;
		socket.user_profile.playerEntity.state = PlayerStateEnum.IDLE;
		socket.user_profile.state = UserStateEnum.LOBBY;
	}
	else if(command === "attack"){
		if(commands.length === 2){
			for(var i in socket.user_profile.playerEntity.cell.enemies){
				if(socket.user_profile.playerEntity.cell.enemies[i].name === commands[1]){
					socket.user_profile.playerEntity.attacking = socket.user_profile.playerEntity.cell.enemies[i];
					break;
				}
			}
		}
	}
	else if(command === "look"){
		for(var i in socket.user_profile.playerEntity.cell.enemies){
			gameMsg(socket, fonts.highlight.output(socket.user_profile.playerEntity.cell.enemies[i].name));
		}
	}
	else if(command.match(/^e$|^east$/i)){
		if(socket.user_profile.playerEntity.cell.e_cell != null){
			if(socket.user_profile.playerEntity.state === PlayerStateEnum.ATTACK){
				escape(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.e_cell));
			}
			else {
				moveToCell(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.e_cell));
			}
		}
		else{
			gameMsg(socket, "You cannot move there");
		}
	}
	else if(command.match(/^w$|^west$/i)){
		if(socket.user_profile.playerEntity.cell.w_cell != null){
			if(socket.user_profile.playerEntity.state === PlayerStateEnum.ATTACK){
				escape(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.w_cell));
			}
			else {
				moveToCell(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.w_cell));
			}
		}
		else{
			gameMsg(socket, "You cannot move there");
		}
	}
	else if(command.match(/^s$|^south$/i)){
		if(socket.user_profile.playerEntity.cell.s_cell != null){
			if(socket.user_profile.playerEntity.state === PlayerStateEnum.ATTACK){
				escape(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.s_cell));
			}
			else {
				moveToCell(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.s_cell));
			}
		}
		else{
			gameMsg(socket, "You cannot move there");
		}
	}
	else if(command.match(/^n$|^north$/i)){
		if(socket.user_profile.playerEntity.cell.n_cell != null){
			if(socket.user_profile.playerEntity.state === PlayerStateEnum.ATTACK){
				escape(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.n_cell));
			}
			else {
				moveToCell(socket.user_profile.playerEntity, findCell(socket.user_profile.playerEntity.cell.n_cell));
			}
		}
		else{
			gameMsg(socket, "You cannot move there");
		}
	}
	else{
		sendMsg(socket, fonts.warning.output("Illegal command"));
	}
}

function moveToCell(player, cell){
	//Remove player from current cell
	player.cell.playerNames = player.cell.playerNames.filter(function(element){return element !== player.name;});
	player.cell = cell;
	//Add player to new cell
	player.cell.playerNames.push(player.name);
	player.attacking = null;
	changeState(player, PlayerStateEnum.MOVED)
}

function escape(player, cell){
	changeState(player, PlayerStateEnum.ESCAPING);
	player.attacking = null;
	player.escaping_cell = cell;
}

function findCell(cellNum){
	for(var i in cells){
		if(cells[i].cellNum == cellNum){
			return cells[i];
		}
	}
	return null;
}

function findPlayer(playerName){
	if(playerName in loginNames){
		if(loginNames[playerName].user_profile.state !== UserStateEnum.GAME){
			return null;
		}
		else {
			return loginNames[playerName].user_profile.playerEntity;
		}
	}
	else{
		return null;
	}
}

function availableMoves(cell){
	var movesStr = "Available directions : ";
	var first = true;
	if(cell.e_cell !== null){
		if(!first){
			movesStr += ", ";
		}
		movesStr += fonts.highlight.output("E");
		first = false;
	}
	if(cell.w_cell !== null){
		if(!first){
			movesStr += ", ";
		}
		movesStr += fonts.highlight.output("W");
		first = false;
	}
	if(cell.s_cell !== null){
		if(!first){
			movesStr += ", ";
		}
		movesStr += fonts.highlight.output("S");
		first = false;
	}
	if(cell.n_cell !== null){
		if(!first){
			movesStr += ", ";
		}
		movesStr += fonts.highlight.output("N");
		first = false;
	}
	return movesStr;
}

function leaveRoom(socket, force_quit){
	function leaveRoomMsg(socket, room){
		for(var i in Object.keys(rooms[room]))
		{
			var name = Object.keys(rooms[room])[i];
			if(socket.user_profile.name === name){
				if(force_quit !== true){
					sendMsg(loginNames[name], fonts.system.output("* user has left chat: " + socket.user_profile.name + " (** this is you)"));
				}
			}
			else{
				sendMsg(loginNames[name], fonts.system.output("* user has left chat: " + socket.user_profile.name));
			}
		}
	}
	if(socket.user_profile.room != ""){ //Quit the current room if possible
		leaveRoomMsg(socket, socket.user_profile.room);
		delete rooms[socket.user_profile.room][socket.user_profile.name]; //remove user from room
		if(Object.keys(rooms[socket.user_profile.room]).length === 0){
			delete rooms[socket.user_profile.room]; //delete room if there is no remaining user
		}
		socket.user_profile.room = "";
	}
	socket.user_profile.state = UserStateEnum.LOBBY;
}

function closeSocket(socket, force_quit) {
	leaveRoom(socket, force_quit);
	var i = sockets.indexOf(socket);
	if (i != -1) {
		delete loginNames[sockets[i].user_profile.name];
		sockets.splice(i, 1);
	}
}

function sendMsg(socket, msg){
	socket.write('<= ' + msg + '\r\n');
}

function gameMsg(socket, msg){
	socket.write(msg + '\r\n');
}

function sendMsgRoom(room, msg){
	for(var i in Object.keys(rooms[room]))
	{
		var name = Object.keys(rooms[room])[i];
		sendMsg(loginNames[name], msg);
	}
}

function broadcastMsg(msg){
	for(var i in sockets) {
	   if(sockets[i].user_profile.state === UserStateEnum.LOBBY){
		   sendMsg(sockets[i], msg);
	   }
	}
}

function broadcastCell(msg){
	//TODO: check room for players
}

function enterRoomMsg(socket, room){
	for(var i in Object.keys(rooms[room]))
	{
		var name = Object.keys(rooms[room])[i];
		if(socket.user_profile.name !== name){
			sendMsg(loginNames[name], fonts.system.output("* new user joined chat: " + socket.user_profile.name));
		}
	}
}

var world = new CGameWorld();
setInterval(function(){
	world.update();
}, WORLD_INTERVAL);

var server = net.createServer(function (socket) {
	socket.buffer = "";
	socket.user_profile = new CUserProfile();
    sockets.push(socket);
	var formatter = new CColorFormatter();
	formatter.color(ColorCodesEnum.BRIGHT_GREEN).bgColor(ColorCodesEnum.RED);
	socket.write('<= Welcome to the ' + formatter.output('RPG') + ' chat server\r\n');
	socket.write(formatter.color(ColorCodesEnum.BRIGHT_WHITE).bgColor(ColorCodesEnum.BLACK).output('<= Login Name?\r\n'));
	socket.on('data', function(data){
		receiveData(socket, data);
	});
	socket.on('end', function() {
		closeSocket(socket);
	})
	socket.on('error', function(err){
		closeSocket(socket, true);
	})
}).listen(8888);

