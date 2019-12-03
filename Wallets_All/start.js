/*jslint node: true */
"use strict";
var fs = require('fs');
var request = require("request");
var device = require('ocore/device.js');
var crypto = require('crypto');
var util = require('util');
var constants = require('ocore/constants.js');
var desktopApp = require('ocore/desktop_app.js');
var appDataDir = desktopApp.getAppDataDir();
var path = require('path');

if (require.main === module && !fs.existsSync(appDataDir) && fs.existsSync(path.dirname(appDataDir)+'/headless-byteball')){
	console.log('=== will rename old data dir');
	fs.renameSync(path.dirname(appDataDir)+'/headless-byteball', appDataDir);
}

var conf = require('ocore/conf.js');
var objectHash = require('ocore/object_hash.js');
var db = require('ocore/db.js');
var eventBus = require('ocore/event_bus.js');
var ecdsaSig = require('ocore/signature.js');
var storage = require('ocore/storage.js');
var Mnemonic = require('bitcore-mnemonic');
var Bitcore = require('bitcore-lib');
var readline = require('readline');

var KEYS_FILENAME = appDataDir + '/' + (conf.KEYS_FILENAME || 'keys.json');
var wallet_id;
var xPrivKey;

//HydrogenTrain
var hydrogenLabel;
//include onoff to interact with the GPIO
var Gpio = require('onoff').Gpio; 
//use GPIO pin 18, and specify that it is output
var pump = new Gpio(18, 'in'); 


function replaceConsoleLog(){
	var log_filename = conf.LOG_FILENAME || (appDataDir + '/log.txt');
	var writeStream = fs.createWriteStream(log_filename);
	console.log('---------------');
	console.log('From this point, output will be redirected to '+log_filename);
	console.log("To release the terminal, type Ctrl-Z, then 'bg'");
	console.log = function(){
		writeStream.write(Date().toString()+': ');
		writeStream.write(util.format.apply(null, arguments) + '\n');
	};
	console.warn = console.log;
	console.info = console.log;
}

function readKeys(onDone){
	console.log('-----------------------');
	if (conf.control_addresses)
		console.log("remote access allowed from devices: "+conf.control_addresses.join(', '));
	if (conf.payout_address)
		console.log("payouts allowed to address: "+conf.payout_address);
	console.log('-----------------------');
	fs.readFile(KEYS_FILENAME, 'utf8', function(err, data){
		var rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			//terminal: true
		});
		if (err){ // first start
			console.log('failed to read keys, will gen');
			initConfJson(rl, function(){
				rl.question('Passphrase for your private keys: ', function(passphrase){
					rl.close();
					if (process.stdout.moveCursor) process.stdout.moveCursor(0, -1);
					if (process.stdout.clearLine)  process.stdout.clearLine();
					var deviceTempPrivKey = crypto.randomBytes(32);
					var devicePrevTempPrivKey = crypto.randomBytes(32);

					var mnemonic = new Mnemonic(); // generates new mnemonic
					while (!Mnemonic.isValid(mnemonic.toString()))
						mnemonic = new Mnemonic();

					writeKeys(mnemonic.phrase, deviceTempPrivKey, devicePrevTempPrivKey, function(){
						console.log('keys created');
						var xPrivKey = mnemonic.toHDPrivateKey(passphrase);
						createWallet(xPrivKey, function(){
							onDone(mnemonic.phrase, passphrase, deviceTempPrivKey, devicePrevTempPrivKey);
						});
					});
				});
			});
		}
		else{ // 2nd or later start
			rl.question("Passphrase: ", function(passphrase){
				rl.close();
				if (process.stdout.moveCursor) process.stdout.moveCursor(0, -1);
				if (process.stdout.clearLine)  process.stdout.clearLine();
				var keys = JSON.parse(data);
				var deviceTempPrivKey = Buffer.from(keys.temp_priv_key, 'base64');
				var devicePrevTempPrivKey = Buffer.from(keys.prev_temp_priv_key, 'base64');
				determineIfWalletExists(function(bWalletExists){
					if (bWalletExists)
						onDone(keys.mnemonic_phrase, passphrase, deviceTempPrivKey, devicePrevTempPrivKey);
					else{
						var mnemonic = new Mnemonic(keys.mnemonic_phrase);
						var xPrivKey = mnemonic.toHDPrivateKey(passphrase);
						createWallet(xPrivKey, function(){
							onDone(keys.mnemonic_phrase, passphrase, deviceTempPrivKey, devicePrevTempPrivKey);
						});
					}
				});
			});
		}
	});
}

function initConfJson(rl, onDone){
	var userConfFile = appDataDir + '/conf.json';
	var confJson = null;
	try {
		confJson = require(userConfFile);
	}
	catch(e){
	}
	if (conf.deviceName && conf.deviceName !== 'Headless') // already set in conf.js or conf.json
		return confJson ? onDone() : writeJson(userConfFile, {}, onDone);
	// continue if device name not set
	if (!confJson)
		confJson = {};
	var suggestedDeviceName = require('os').hostname() || 'Headless';
	rl.question("Please name this device ["+suggestedDeviceName+"]: ", function(deviceName){
		if (!deviceName)
			deviceName = suggestedDeviceName;
		confJson.deviceName = deviceName;
		writeJson(userConfFile, confJson, function(){
			console.log('Device name saved to '+userConfFile+', you can edit it later if you like.\n');
			onDone();
		});
	});
}

function writeJson(filename, json, onDone){
	fs.writeFile(filename, JSON.stringify(json, null, '\t'), 'utf8', function(err){
		if (err)
			throw Error('failed to write conf.json: '+err);
		onDone();
	});
}

function writeKeys(mnemonic_phrase, deviceTempPrivKey, devicePrevTempPrivKey, onDone){
	var keys = {
		mnemonic_phrase: mnemonic_phrase,
		temp_priv_key: deviceTempPrivKey.toString('base64'),
		prev_temp_priv_key: devicePrevTempPrivKey.toString('base64')
	};
	fs.writeFile(KEYS_FILENAME, JSON.stringify(keys, null, '\t'), 'utf8', function(err){
		if (err)
			throw Error("failed to write keys file");
		if (onDone)
			onDone();
	});
}

function createWallet(xPrivKey, onDone){
	var devicePrivKey = xPrivKey.derive("m/1'").privateKey.bn.toBuffer({size:32});
	var device = require('ocore/device.js');
	device.setDevicePrivateKey(devicePrivKey); // we need device address before creating a wallet
	var strXPubKey = Bitcore.HDPublicKey(xPrivKey.derive("m/44'/0'/0'")).toString();
	var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
	// we pass isSingleAddress=false because this flag is meant to be forwarded to cosigners and headless wallet doesn't support multidevice
	walletDefinedByKeys.createWalletByDevices(strXPubKey, 0, 1, [], 'any walletName', false, function(wallet_id){
		walletDefinedByKeys.issueNextAddress(wallet_id, 0, function(addressInfo){
			onDone();
		});
	});
}

function isControlAddress(device_address){
	return (conf.control_addresses && conf.control_addresses.indexOf(device_address) >= 0);
}

function readSingleAddress(handleAddress){
	db.query("SELECT address FROM my_addresses WHERE wallet=?", [wallet_id], function(rows){
		if (rows.length === 0)
			throw Error("no addresses");
		if (rows.length > 1)
			throw Error("more than 1 address");
		handleAddress(rows[0].address);
	});
}

function readFirstAddress(handleAddress){
	db.query("SELECT address FROM my_addresses WHERE wallet=? AND address_index=0 AND is_change=0", [wallet_id], function(rows){
		if (rows.length === 0)
			throw Error("no addresses");
		if (rows.length > 1)
			throw Error("more than 1 address");
		handleAddress(rows[0].address);
	});
}

function prepareBalanceText(handleBalanceText){
	var Wallet = require('ocore/wallet.js');
	Wallet.readBalance(wallet_id, function(assocBalances){
		var arrLines = [];
		for (var asset in assocBalances){
			var total = assocBalances[asset].stable + assocBalances[asset].pending;
			var units = (asset === 'base') ? ' bytes' : (' of ' + asset);
			var line = total + units;
			if (assocBalances[asset].pending)
				line += ' (' + assocBalances[asset].pending + ' pending)';
			arrLines.push(line);
		}
		handleBalanceText(arrLines.join("\n"));
	});
}

function readSingleWallet(handleWallet){
	db.query("SELECT wallet FROM wallets", function(rows){
		if (rows.length === 0)
			throw Error("no wallets");
		if (rows.length > 1)
			throw Error("more than 1 wallet");
		handleWallet(rows[0].wallet);
	});
}

function determineIfWalletExists(handleResult){
	db.query("SELECT wallet FROM wallets", function(rows){
		if (rows.length > 1)
			throw Error("more than 1 wallet");
		handleResult(rows.length > 0);
	});
}

function signWithLocalPrivateKey(wallet_id, account, is_change, address_index, text_to_sign, handleSig){
	var path = "m/44'/0'/" + account + "'/"+is_change+"/"+address_index;
	var privateKey = xPrivKey.derive(path).privateKey;
	var privKeyBuf = privateKey.bn.toBuffer({size:32}); // https://github.com/bitpay/bitcore-lib/issues/47
	handleSig(ecdsaSig.sign(text_to_sign, privKeyBuf));
}

var signer = {
	readSigningPaths: function(conn, address, handleLengthsBySigningPaths){
		handleLengthsBySigningPaths({r: constants.SIG_LENGTH});
	},
	readDefinition: function(conn, address, handleDefinition){
		conn.query("SELECT definition FROM my_addresses WHERE address=?", [address], function(rows){
			if (rows.length !== 1)
				throw Error("definition not found");
			handleDefinition(null, JSON.parse(rows[0].definition));
		});
	},
	sign: function(objUnsignedUnit, assocPrivatePayloads, address, signing_path, handleSignature){
		var buf_to_sign = objectHash.getUnitHashToSign(objUnsignedUnit);
		db.query(
			"SELECT wallet, account, is_change, address_index \n\
			FROM my_addresses JOIN wallets USING(wallet) JOIN wallet_signing_paths USING(wallet) \n\
			WHERE address=? AND signing_path=?",
			[address, signing_path],
			function(rows){
				if (rows.length !== 1)
					throw Error(rows.length+" indexes for address "+address+" and signing path "+signing_path);
				var row = rows[0];
				signWithLocalPrivateKey(row.wallet, row.account, row.is_change, row.address_index, buf_to_sign, function(sig){
					handleSignature(null, sig);
				});
			}
		);
	}
};


if (conf.permanent_pairing_secret)
	db.query(
		"INSERT "+db.getIgnore()+" INTO pairing_secrets (pairing_secret, is_permanent, expiry_date) VALUES (?, 1, '2038-01-01')",
		[conf.permanent_pairing_secret]
	);

setTimeout(function(){
	readKeys(function(mnemonic_phrase, passphrase, deviceTempPrivKey, devicePrevTempPrivKey){
		var saveTempKeys = function(new_temp_key, new_prev_temp_key, onDone){
			writeKeys(mnemonic_phrase, new_temp_key, new_prev_temp_key, onDone);
		};
		var mnemonic = new Mnemonic(mnemonic_phrase);
		// global
		xPrivKey = mnemonic.toHDPrivateKey(passphrase);
		var devicePrivKey = xPrivKey.derive("m/1'").privateKey.bn.toBuffer({size:32});
		// read the id of the only wallet
		readSingleWallet(function(wallet){
			// global
			wallet_id = wallet;
			require('ocore/wallet.js'); // we don't need any of its functions but it listens for hub/* messages
			var device = require('ocore/device.js');
			device.setDevicePrivateKey(devicePrivKey);
			let my_device_address = device.getMyDeviceAddress();
			db.query("SELECT 1 FROM extended_pubkeys WHERE device_address=?", [my_device_address], function(rows){
				if (rows.length > 1)
					throw Error("more than 1 extended_pubkey?");
				if (rows.length === 0)
					return setTimeout(function(){
						console.log('passphrase is incorrect');
						process.exit(0);
					}, 1000);
				device.setTempKeys(deviceTempPrivKey, devicePrevTempPrivKey, saveTempKeys);
				device.setDeviceName(conf.deviceName);
				device.setDeviceHub(conf.hub);
				let my_device_pubkey = device.getMyDevicePubKey();
				console.log("====== my device address: "+my_device_address);
				console.log("====== my device pubkey: "+my_device_pubkey);
				if (conf.bSingleAddress)
					readSingleAddress(function(address){
						console.log("====== my single address: "+address);
					});
				else
					readFirstAddress(function(address){
						console.log("====== my first address: "+address);
					});

				if (conf.permanent_pairing_secret)
					console.log("====== my pairing code: "+my_device_pubkey+"@"+conf.hub+"#"+conf.permanent_pairing_secret);
				if (conf.bLight){
					var light_wallet = require('ocore/light_wallet.js');
					light_wallet.setLightVendorHost(conf.hub);
				}
				eventBus.emit('headless_wallet_ready');
				setTimeout(replaceConsoleLog, 1000);
				if (conf.MAX_UNSPENT_OUTPUTS && conf.CONSOLIDATION_INTERVAL){
					var consolidation = require('./consolidation.js');
					consolidation.scheduleConsolidation(wallet_id, signer, conf.MAX_UNSPENT_OUTPUTS, conf.CONSOLIDATION_INTERVAL);
				}
			});
		});
	});
}, 1000);


function handlePairing(from_address){
	var device = require('ocore/device.js');
	prepareBalanceText(function(balance_text){
		device.sendMessageToDevice(from_address, 'text', balance_text);
	});
}

function sendPayment(asset, amount, to_address, change_address, device_address, onDone){
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendPayment(asset, amount, to_address, change_address, device_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	Wallet.sendPaymentFromWallet(
		asset, wallet_id, to_address, amount, change_address,
		[], device_address,
		signWithLocalPrivateKey,
		function(err, unit, assocMnemonics){
			if (device_address) {
				if (err)
					device.sendMessageToDevice(device_address, 'text', "Failed to pay: " + err);
				//	else
				// if successful, the peer will also receive a payment notification
				//		device.sendMessageToDevice(device_address, 'text', "paid");
		}
		if (onDone)
				onDone(err, unit, assocMnemonics);
		}
	);
}

function sendMultiPayment(opts, onDone){
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendMultiPayment(opts, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	if (!opts.paying_addresses)
		opts.wallet = wallet_id;
	opts.arrSigningDeviceAddresses = [device.getMyDeviceAddress()];
	opts.signWithLocalPrivateKey = signWithLocalPrivateKey;
	Wallet.sendMultiPayment(opts, (err, unit, assocMnemonics) => {
		if (onDone)
			onDone(err, unit, assocMnemonics);
	});
}

function sendPaymentUsingOutputs(asset, outputs, change_address, onDone) {
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendPaymentUsingOutputs(asset, outputs, change_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	var opt = {
		asset: asset,
		wallet: wallet_id,
		change_address: change_address,
		arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
		recipient_device_address: null,
		signWithLocalPrivateKey: signWithLocalPrivateKey
	};
	if(asset === 'base' || asset === null){
		opt.base_outputs = outputs;
	}else{
		opt.asset_outputs = outputs;
	}
	Wallet.sendMultiPayment(opt, (err, unit, assocMnemonics) => {
		if (onDone)
			onDone(err, unit, assocMnemonics);
	});
}

function sendAllBytes(to_address, recipient_device_address, onDone) {
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendAllBytes(to_address, recipient_device_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	Wallet.sendMultiPayment({
		asset: null,
		to_address: to_address,
		send_all: true,
		wallet: wallet_id,
		arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
		recipient_device_address: recipient_device_address,
		signWithLocalPrivateKey: signWithLocalPrivateKey
	}, (err, unit, assocMnemonics) => {
		if (onDone)
			onDone(err, unit, assocMnemonics);
	});
}

function sendAllBytesFromAddress(from_address, to_address, recipient_device_address, onDone) {
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendAllBytesFromAddress(from_address, to_address, recipient_device_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	Wallet.sendMultiPayment({
		asset: null,
		to_address: to_address,
		send_all: true,
		paying_addresses: [from_address],
		arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
		recipient_device_address: recipient_device_address,
		signWithLocalPrivateKey: signWithLocalPrivateKey
	}, (err, unit, assocMnemonics) => {
		if(onDone)
			onDone(err, unit, assocMnemonics);
	});
}

function sendAssetFromAddress(asset, amount, from_address, to_address, recipient_device_address, onDone) {
	if(!onDone) {
		return new Promise((resolve, reject) => {
			sendAssetFromAddress(asset, amount, from_address, to_address, recipient_device_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	Wallet.sendMultiPayment({
		fee_paying_wallet: wallet_id,
		asset: asset,
		to_address: to_address,
		amount: amount,
		paying_addresses: [from_address],
		change_address: from_address,
		arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
		recipient_device_address: recipient_device_address,
		signWithLocalPrivateKey: signWithLocalPrivateKey
	}, (err, unit, assocMnemonics) => {
		if (onDone)
			onDone(err, unit, assocMnemonics);
	});
}

function issueChangeAddressAndSendPayment(asset, amount, to_address, device_address, onDone){
	if(!onDone) {
		return new Promise((resolve, reject) => {
			issueChangeAddressAndSendPayment(asset, amount, to_address, device_address, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	issueChangeAddress(function(change_address){
		sendPayment(asset, amount, to_address, change_address, device_address, onDone);
	});
}

function issueChangeAddressAndSendMultiPayment(opts, onDone){
	if(!onDone) {
		return new Promise((resolve, reject) => {
			issueChangeAddressAndSendMultiPayment(opts, (err, unit, assocMnemonics) => {
				if (err) return reject(new Error(err));
				return resolve({unit, assocMnemonics});
			});
		});
	}
	issueChangeAddress(function(change_address){
		opts.change_address = change_address;
		sendMultiPayment(opts, onDone);
	});
}

function issueOrSelectNextMainAddress(handleAddress){
	var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
	walletDefinedByKeys.issueOrSelectNextAddress(wallet_id, 0, function(objAddr){
		handleAddress(objAddr.address);
	});
}

function issueNextMainAddress(handleAddress){
	var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
	walletDefinedByKeys.issueNextAddress(wallet_id, 0, function(objAddr){
		handleAddress(objAddr.address);
	});
}

function issueOrSelectAddressByIndex(is_change, address_index, handleAddress){
	var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
	walletDefinedByKeys.readAddressByIndex(wallet_id, is_change, address_index, function(objAddr){
		if (objAddr)
			return handleAddress(objAddr.address);
		walletDefinedByKeys.issueAddress(wallet_id, is_change, address_index, function(objAddr){
			handleAddress(objAddr.address);
		});
	});
}

function issueOrSelectStaticChangeAddress(handleAddress){
	issueOrSelectAddressByIndex(1, 0, handleAddress);
}

function issueChangeAddress(handleAddress){
	if (conf.bSingleAddress)
		readSingleAddress(handleAddress);
	else if (conf.bStaticChangeAddress)
		issueOrSelectStaticChangeAddress(handleAddress);
	else{
		var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
		walletDefinedByKeys.issueOrSelectNextChangeAddress(wallet_id, function(objAddr){
			handleAddress(objAddr.address);
		});
	}
}


function signMessage(signing_address, message, cb) {
	var device = require('ocore/device.js');
	var Wallet = require('ocore/wallet.js');
	Wallet.signMessage(signing_address, message, [device.getMyDeviceAddress()], signWithLocalPrivateKey, cb);
}


function handleText(from_address, text, onUnknown){	
	text = text.trim();
	var fields = text.split(/ /);
	var command = fields[0].trim().toLowerCase();
	var params =['',''];
	if (fields.length > 1) params[0] = fields[1].trim();
	if (fields.length > 2) params[1] = fields[2].trim();
	if (fields.length > 3) params[2] = fields[3].trim();

	var walletDefinedByKeys = require('ocore/wallet_defined_by_keys.js');
	var device = require('ocore/device.js');
	switch(command){
		case 'address':
			if (conf.bSingleAddress)
				readSingleAddress(function(address){
					device.sendMessageToDevice(from_address, 'text', address);
				});
			else
				walletDefinedByKeys.issueOrSelectNextAddress(wallet_id, 0, function(addressInfo){
					device.sendMessageToDevice(from_address, 'text', addressInfo.address);
				});
			break;
			
		case 'balance':
			prepareBalanceText(function(balance_text){
				device.sendMessageToDevice(from_address, 'text', balance_text);
			});
			break;
			
		case 'pay':
			analyzePayParams(params[0], params[1], function(asset, amount){
				if(asset===null && amount===null){
					var msg = "syntax: pay [amount] [asset]";
					msg +=	"\namount: digits only";
					msg +=	"\nasset: one of '', 'bytes', 'blackbytes', ASSET_ID";
					msg +=	"\n";
					msg +=	"\nExample 1: 'pay 12345' pays 12345 bytes";
					msg +=	"\nExample 2: 'pay 12345 bytes' pays 12345 bytes";
					msg +=	"\nExample 3: 'pay 12345 blackbytes' pays 12345 blackbytes";
					msg +=	"\nExample 4: 'pay 12345 qO2JsiuDMh/j+pqJYZw3u82O71WjCDf0vTNvsnntr8o=' pays 12345 blackbytes";
					msg +=	"\nExample 5: 'pay 12345 ASSET_ID' pays 12345 of asset with ID ASSET_ID";
					return device.sendMessageToDevice(from_address, 'text', msg);
				}

				if (!conf.payout_address)
					return device.sendMessageToDevice(from_address, 'text', "payout address not defined");

				function payout(amount, asset){
					if (conf.bSingleAddress)
						readSingleAddress(function(address){
							sendPayment(asset, amount, conf.payout_address, address, from_address);
						});
					else
						// create a new change address or select first unused one
						issueChangeAddressAndSendPayment(asset, amount, conf.payout_address, from_address);
				};

				if(asset!==null){
					db.query("SELECT unit FROM assets WHERE unit=?", [asset], function(rows){
						if(rows.length===1){
							// asset exists
							payout(amount, asset);
						}else{
							// unknown asset
							device.sendMessageToDevice(from_address, 'text', 'unknown asset: '+asset);
						}
					});
				}else{
					payout(amount, asset);
				}

			});
			break;
		
		/*--------------------------------------handle smart contracts-------------------------------------------*/
		case 'hydrogenpay':

			//params[0], params[1], params[2] = data after keyword hydrogenpay in message
			var smartContractAddress = params[2];
			var smartContractAmount = params[1];
			var smartContractLabel = params[0];

			hydrogenLabel = smartContractLabel;
			
			//move arm to filling position
			const spawn = require("child_process").spawn;
			const pythonProcess = spawn('python3',["./stepper.py", 'backward', '100']); //move arm via python script 
			
			//start filling train tank
			setTimeout(function () {
				pump = new Gpio(18, 'out'); 
				pump.writeSync(1);
			  }, 2000);
			
			//start train 
			var url = "http://10.0.1.14/fillingTank";

			request(url, function (error, response, body) {
				if (error || response.statusCode !== 200) {

					//if train is unreachable or connection is lost, stop filling and move arm back to avoid further damage
					pump.writeSync(0);
					pump = new Gpio(18, 'in'); 
					const pythonProcess = spawn('python3',["./stepper.py", 'forward', '100']); //move arm via python script 
				}
			})

			/*--------------------------------------do s.th. cool with amount in smart wallet------------------------------*/

			break;

		case 'mci':
			storage.readLastMainChainIndex(function(last_mci){
				device.sendMessageToDevice(from_address, 'text', last_mci.toString());
			});
			break;

		case 'space':
			getFileSizes(appDataDir, function(data) {
				var total_space = 0;
				var response = '';
				Object.keys(data).forEach(function(key) {
					total_space += data[key];
					response += key +' '+ niceBytes(data[key]) +"\n";
				});
				response += 'Total: '+ niceBytes(total_space);
				device.sendMessageToDevice(from_address, 'text', response);
			});
			break;

		case 'unrecognizedcommand':
				break;

		default:
			if (onUnknown){
				onUnknown(from_address, text);
			}else{
				device.sendMessageToDevice(from_address, 'text', "unrecognizedcommand");
			}
	}
}

function niceBytes(x){
	// source: https://stackoverflow.com/a/39906526
	const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	let l = 0, n = parseInt(x, 10) || 0;
	while(n >= 1024 && ++l)
			n = n/1024;

	//include a decimal point and a tenths-place digit if presenting 
	//less than ten of KB or greater units
	return(n.toFixed(n < 10 && l > 0 ? 1 : 0) + ' ' + units[l]);
}

function getFileSizes(rootDir, cb) {
	fs.readdir(rootDir, function(err, files) {
		var fileSizes = {};
		for (var index = 0; index < files.length; ++index) {
			var file = files[index];
			if (file[0] !== '.') {
				var filePath = rootDir + '/' + file;
				fs.stat(filePath, function(err, stat) {
					if (stat.isFile()) {
						fileSizes[this.file] = stat['size'];
					}
					if (files.length === (this.index + 1)) {
						return cb(fileSizes);
					}
				}.bind({index: index, file: file}));
			}
		}
	});
}

function analyzePayParams(amountText, assetText, cb){
	// expected:
	// amountText = amount; only digits
	// assetText = asset; '' -> whitebytes, 'bytes' -> whitebytes, 'blackbytes' -> blackbytes, '{asset-ID}' -> any asset

	if (amountText===''&&assetText==='') return cb(null, null);

	var pattern = /^\d+$/;
    if(pattern.test(amountText)){

		var amount = parseInt(amountText);

		var asset = assetText.toLowerCase();
		switch(asset){
			case '':
			case 'bytes':
				return cb(null, amount);
			case 'blackbytes':
				return cb(constants.BLACKBYTES_ASSET, amount);
			default:
				// return original assetText string because asset ID it is case sensitive
				return cb(assetText, amount);
		}

	}else{
		return cb(null, null);
	}
}

// The below events can arrive only after we read the keys and connect to the hub.
// The event handlers depend on the global var wallet_id being set, which is set after reading the keys

function setupChatEventHandlers(){
	eventBus.on('paired', function(from_address){
		console.log('paired '+from_address);
		if (!isControlAddress(from_address))
			return console.log('ignoring pairing from non-control address');
		handlePairing(from_address);
	});

	eventBus.on('text', function(from_address, text){
		console.log('text from '+from_address+': '+text);
		if (!isControlAddress(from_address))
			return console.log('ignoring text from non-control address');
		handleText(from_address, text);
	});
}

exports.readSingleWallet = readSingleWallet;
exports.readSingleAddress = readSingleAddress;
exports.readFirstAddress = readFirstAddress;
exports.signer = signer;
exports.isControlAddress = isControlAddress;
exports.issueOrSelectNextMainAddress = issueOrSelectNextMainAddress;
exports.issueNextMainAddress = issueNextMainAddress;
exports.issueOrSelectAddressByIndex = issueOrSelectAddressByIndex;
exports.issueOrSelectStaticChangeAddress = issueOrSelectStaticChangeAddress;
exports.issueChangeAddressAndSendPayment = issueChangeAddressAndSendPayment;
exports.signMessage = signMessage;
exports.signWithLocalPrivateKey = signWithLocalPrivateKey;
exports.setupChatEventHandlers = setupChatEventHandlers;
exports.handlePairing = handlePairing;
exports.handleText = handleText;
exports.sendAllBytesFromAddress = sendAllBytesFromAddress;
exports.sendAssetFromAddress = sendAssetFromAddress;
exports.sendAllBytes = sendAllBytes;
exports.sendPaymentUsingOutputs = sendPaymentUsingOutputs;
exports.sendMultiPayment = sendMultiPayment;
exports.issueChangeAddressAndSendMultiPayment = issueChangeAddressAndSendMultiPayment;

if (require.main === module)
	setupChatEventHandlers();

/*--------------------------------------hydrogen api-------------------------------------------*/

//initialise server and api variables
var http = require('http');
var gasStationUrl = '10.0.1.10';
var marketUrl = '10.0.1.11';
var oracleUrl = '10.0.1.12';
var tankUrl = '10.0.1.13';
var espUrl = '10.0.1.14';
var price = null;
var brand = null;

//Init step 1 on UI
setStep(1, null, null);

const express = require('express'),
      app = express(),
	  bodyParser = require('body-parser');
	  
//makes dir /public public
app.use(express.static(__dirname + '/public'));	

//starts server
app.listen(8080);

// support parsing of application/json type post data
app.use(bodyParser.json());

//support parsing of application/x-www-form-urlencoded post data
app.use(bodyParser.urlencoded({ extended: true }));

//define url to post data to start process
app.get("/checkIfTankEmpty", function(req,res,next){
	//handle request
	res.send('Getting Tank Request: Ok');
	checkTank();

	//repeat getting tank status, until tank ist empty
	function checkTank() {
		request('http://' + tankUrl + "/tankStatus", function (error, response, body) {
		if (!error && response.statusCode === 200) {
			if(body.toString() === "empty") {
				requestPrices();
				//advance to step 3 on UI
				setStep(3, "null", "null");
				sendStep(false, true, true, 3, "null", "null");
			}
			else {
				checkTank();
			}
		}
	})	
	}
})

//set steps for UI from api
app.post("/setStep", function(req,res,next){
	//handle request
	res.send('Ok'); //give positive result - doesn't matter what is the content, but it is needed so the esp8266 gets Status Code 200
	try {
		var stepData = JSON.parse(req.body);
	}
	catch {
		var stepData = req.body;
	}
	
	setStep(stepData.step, stepData.price, stepData.brand);
})

//stop filling when train tank is full
app.post("/trainTankFilled", function(req,res,next){
	//handle request

	//stop pump from filling tank
	pump.writeSync(0);
	pump = new Gpio(18, 'in'); 

	//give positive result and send back hydrogen label to display
	res.send(hydrogenLabel + "               ");

	//move arm via python script 
	const spawn = require("child_process").spawn;
	const pythonProcess = spawn('python',["./stepper.py", 'forward', '100']);

	setTimeout(function(){
		//advance to step 8 on UI
		setStep(8, price, brand);
		setTimeout(function(){
			//advance to step 9 on UI
			setStep(9, price, brand);
			sendStep(true, false, true, 9, price, brand)
		}, 2000);
	}, 1000);

	//Send Data to DAG: "sent" == "true" 
	postDataToDAG("sent", "true");
})

//tell GS when hydrogen has arrived
app.post("/trainHydrogenDelivered", function(req,res,next){
	//handle request
	res.send('Ok'); //give positive result and send back Ok
	//advance to step 10 on UI
	setStep(10, price, brand);
	sendStep(true, false, true, 10, price, brand)
	setTimeout(function(){
		//advance to step 11 on UI
		setStep(11, price, brand);
		sendStep(false, true, true, 11, price, brand)
		setTimeout(function(){
			//advance to step 12 on UI
			setStep(12, price, brand);
			sendStep(false, true, true, 12, price, brand)
		}, 3000);
	}, 2000);
	
	//Send Data to DAG: "delivered" == "true" 
	postDataToDAG("delivered", "true");
})

//End Process / show finished
app.post("/finished", function(req,res,next){
	//handle request
	res.send('Ok'); //give positive result and send back Ok
	sendStep(true, true, false, 12);
	setTimeout(function(){
		//advance to step 1 on UI
		setStep(1, "null", "null");
		sendStep(true, true, false, 1, "null", "null")
	}, 6000);
})

//Tell Rpis to start
app.post("/start", function(req,res,next){
	//handle request
	res.send('Ok'); //give positive result and send back Ok
	//advance to step 2 on UI
	setStep(2, "null", "null");
	sendStep(true, true, false, 2, "null", "null")

	//tell GS to check Tank
	request('http://' + gasStationUrl + ":8080/checkIfTankEmpty", function (error, response, body) {
	})
})

function requestPrices(){
	var url = "http://10.0.1.11:8080/data/prices.json";

	//get all price offers from market
	request(url, function (error, response, body) {
		if (!error && response.statusCode === 200) {
			var prices = JSON.parse(body);

			//compare prices and select cheapest offer
			var [brand, price] = comparePrices(prices);
			setTimeout(function() {
				//advance to step 4 on UI
				setStep(4, price, brand);
				sendStep(false, true, true, 4, price, brand)
				setTimeout(function() {
					//advance to step 5 on UI
					setStep(5, price, brand);
					sendStep(false, true, true, 5, price, brand)
					createSmartContract(brand, price);	
				}, 2000)
			}, 2000)
		}
	})
}

//save step to JSON file
function setStep(step, price=null, brand=null) {
	fs.writeFileSync(__dirname + '/public/data/uidata.json', JSON.stringify({"step": step, "price" : price, "brand": brand}));
}

//send new step to other devices
function sendStep(gasStation=false, market=false, oracle=false, step, price=null, brand=null) {
	var postdata = JSON.stringify({ 
			"step": step, 
			"price" : price, 
			"brand": brand
	})

	if(gasStation) {
		postStep(gasStationUrl, postdata);
	}
	if(market) {
		postStep(marketUrl, postdata);
	}
	if(oracle) {
		postStep(oracleUrl, postdata);
	}
}

//send request with POST method
function postStep(url, data) {
	var http = require("http");

	//create request
	var req = http.request(
		{
			hostname: url, 
			path: "/setStep", 
			port: 8080, 
			method: 'POST',  
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': data.length
			  }
		}, (res) => {

		})
	
	//create error fallback
	req.on('error', (error) => {
		device.sendMessageToDevice("0SNA3YOD3D3G3ZLHDJJPHZNVOCKK3UTTD", 'text', "Error: " + error);
	})

	//send request
	req.write(data)
	req.end()
}

//get lowest price per liter, and return the offer
function comparePrices(prices){
	var lowestPrice = 1000;
	var lowestPriceTag = "";
	for (var brand in prices) {
		if(prices[brand] <= lowestPrice) {
			lowestPrice = prices[brand];
			lowestPriceTag = brand;
		}
	}
	return [lowestPriceTag, lowestPrice];
}

//create Smart Contract for offer and request refill
function createSmartContract(brand, price){
	//define addresses for smart contract
	var marketAddress = "FSJUR3FLUHE7W24DTZWTQBFU4JADU4AX"; //Wallet address: FSJUR3FLUHE7W24DTZWTQBFU4JADU4AX  PC address - 3XH6MMU424NQWPP2E3NBGKAQVTHXYQOH Market
	var gasStationAddress = "BWISWBYQGNI22ESDJ5T5USYAVJZPUYT2"; //Wallet address: GS address
	var marketDeviceAddress = '0S624LPTJEGMHBEKQXLM54MDROQMW6LGN'; //Device address: 0SNA3YOD3D3G3ZLHDJJPHZNVOCKK3UTTD PC Device address - 0S624LPTJEGMHBEKQXLM54MDROQMW6LGN MarketDevice
	var gasStationDeviceAddress = "0QBMYBTEU3KC5Y6TGUNOFEDDLVE7HCCQK"; //Device address: 0QBMYBTEU3KC5Y6TGUNOFEDDLVE7HCCQK GS Device address	
	var shared_address = "";

	//create smart contract definitions and conditions
	var arrDefinition = ['or', 
		[
			['and', 
				[	
					//conditions when the Gas Station can unlock the contract
					['address', gasStationAddress],
					['in data feed', [[marketAddress], 'sent', '!=', 'true']]
				]
			],
			['and', 
				[
					//conditions when market can unlock the contract
					['address', marketAddress],
					['in data feed', [[gasStationAddress], 'delivered', '=', 'true']]
				]
			]
		]
	];

	//define addresses for access to smart contract
	var assocSignersByPath = {
		'r.0.0': {
			address: gasStationAddress,
			member_signing_path: 'r', // unused, should be always 'r'
			device_address: gasStationDeviceAddress
		},
		'r.1.0': {
			address: marketAddress,
			member_signing_path: 'r', // unused, should be always 'r'
			device_address: marketDeviceAddress
		}
	};

	//create smart contract on DAG
	var walletDefinedByAddresses = require('ocore/wallet_defined_by_addresses.js');
	walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
		ifError: function(err){
			//on fail: output error
			device.sendMessageToDevice("0SNA3YOD3D3G3ZLHDJJPHZNVOCKK3UTTD", 'text', "Error: " + err);
		},
		ifOk: function(shared_address_tmp){
			//on success: save new created smart contract address and share it with market
			shared_address = shared_address_tmp;
			device.sendMessageToDevice(marketDeviceAddress, 'text', ('hydrogenpay ' + brand + ' ' + price + ' ' + shared_address), null, null);
		}
	});

	setTimeout(function(){
		//advance to step 6 on UI
		setStep(6, price, brand);
		sendStep(false, true, true, 7, price, brand)
		//advance to step 7 on UI
		setTimeout(function(){
			setStep(7, price, brand);
		}, 1000);
	}, 1000);
	
	//Payment to shared address
	if (conf.bSingleAddress)
		readSingleAddress(function(address){
			sendPayment(null, price, shared_address, address, gasStationDeviceAddress);
		});
	else
		// create a new change address or select first unused one
		issueChangeAddressAndSendPayment(null, price, shared_address, gasStationDeviceAddress);
	
}

//Posting data into DAG
function postDataToDAG(dataKey, dataValue) {
	const objectHash = require('ocore/object_hash.js');
	
	//Create data and format it
	let json_data = {};
	json_data[dataKey] = dataValue;

    let objMessage = {
        app: 'data',
        payload_location: 'inline',
        payload_hash: objectHash.getBase64Hash(json_data),
        payload: json_data
    };
    let opts = {
        messages: [objMessage]
    };

	//Send data to DAG
    issueChangeAddressAndSendMultiPayment(opts, (err, unit) => {
        if (err){
            /*
            something went wrong,
            maybe put this transaction on a retry queue
            */
		   	console.error(err);
            return;
        }
    });
}

//Market functions
'use strict';

//Initialise price list
let prices = {
			Agip: 10,
			Aral: 10,
			Avia: 10,
			BayWa: 10,
			bft: 10,
			Classic: 10,
			ED: 10,
			Elan: 10,
			Esso: 10,
			GO: 10,
			HEM: 10,
			Hoyer: 10,
			Jet: 10,
			Markant: 10,
			Oil: 10,
			Omv: 10,
			Q1: 10,
			Raiffeisen: 10,
			Shell: 10,
			Sprint: 10,
			Star: 10,
			Team: 10,
			Total: 10,
			Westfalen: 10,			
		};
 
//Initialies Price timeout in milliseconds when to change prices
let pricesTimeout = {
			Agip: 1000,
			Aral: 1000,
			Avia: 1000,
			BayWa: 1000,
			bft: 1000,
			Classic: 1000,
			ED: 1000,
			Elan: 1000,
			Esso: 1000,
			GO: 1000,
			HEM: 1000,
			Hoyer: 1000,
			Jet: 1000,
			Markant: 1000,
			Oil: 1000,
			Omv: 1000,
			Q1: 1000,
			Raiffeisen: 1000,
			Shell: 1000,
			Sprint: 1000,
			Star: 1000,
			Team: 1000,
			Total: 1000,
			Westfalen: 1000,
		};

//Random function, returns random number
function getRndInteger(min, max) {
	return Math.floor(Math.random() * (max - min) ) + min;
}

//Set new price and price timeout for each individual price
function setPriceTimeout(label) {
	var newPrice = getRndInteger(100, 1000);
	var timeout = getRndInteger(1000, 60000);
	
	//save new values
	prices[label] = newPrice;
	pricesTimeout[label] = timeout;
	
	//set new timeout
	setTimeout(function() { setPriceTimeout(label);}, timeout);
	
	//write new values to file
	let pricedata = JSON.stringify(prices);
	fs.writeFileSync(__dirname + '/public/data/prices.json', pricedata);
	
	let timeoutdata = JSON.stringify(pricesTimeout);
	fs.writeFileSync(__dirname + '/public/data/pricestimeout.json', timeoutdata);
}

//start prices timeout
for (var label in pricesTimeout) {	
	setPriceTimeout(label);
}

//decrease timeout in 100ms interval
function refreshTimeouts() {
	for (var label in pricesTimeout) {	
		pricesTimeout[label] = pricesTimeout[label] - 100;
	}
	let timeoutdata = JSON.stringify(pricesTimeout);
	fs.writeFileSync(__dirname + '/public/data/pricestimeout.json', timeoutdata);
}
setInterval(refreshTimeouts, 100); 
