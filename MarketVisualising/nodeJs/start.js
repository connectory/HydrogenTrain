var http = require('http');
var express = require('express');

var app = new express();

app.use(express.static(__dirname + '/public'));	

app.listen(8080);

'use strict';

const fs = require('fs');

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
		
function getRndInteger(min, max) {
	return Math.floor(Math.random() * (max - min) ) + min;
}
		
function setPriceTimeout(label) {
	var newPrice = getRndInteger(100, 1000);
	var timeout = getRndInteger(1000, 60000);
	
	prices[label] = newPrice;
	pricesTimeout[label] = timeout;
	
	setTimeout(function() { setPriceTimeout(label);}, timeout);
	
	let pricedata = JSON.stringify(prices);
	fs.writeFileSync('./public/data/prices.json', pricedata);
	
	let timeoutdata = JSON.stringify(pricesTimeout);
	fs.writeFileSync('./public/data/pricestimeout.json', timeoutdata);
}
 
for (var label in pricesTimeout) {	
	setPriceTimeout(label);
}

function refreshTimeouts() {
	for (var label in pricesTimeout) {	
		pricesTimeout[label] = pricesTimeout[label] - 100;
	}
	let timeoutdata = JSON.stringify(pricesTimeout);
	fs.writeFileSync('./public/data/pricestimeout.json', timeoutdata);
}
setInterval(refreshTimeouts, 100);
