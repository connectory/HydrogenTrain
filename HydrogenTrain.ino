#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2); //Hier wird festgelegt um was für einen Display es sich handelt. In diesem Fall eines mit 16 Zeichen in 2 Zeilen und der HEX-Adresse 0x27. Für ein vierzeiliges I2C-LCD verwendet man den Code "LiquidCrystal_I2C lcd(0x27, 20, 4)" 

#include "src/PoweredUpHub.h"

// create a hub instance
PoweredUpHub myTrainHub;
PoweredUpHub::Port _port = PoweredUpHub::Port::A;

/*----------------------------------------Train Variables---------------------------------------------*/
//Wifi Credentials
const char* ssid = "Connectory Hackathon I";
const char* password = "connectory2019";

//Water Sensor
const int waterSensorFull = 2;
const int waterSensorEmpty = 0;
int fullValue = 0;
int emptyValue = 0;

/*----------------------------------------Wifi Setup--------------------------------------------------*/

WebServer server(80);

const int led = 13;


/*-------------------------------------------Train Methods---------------------------------------------*/

//Test to check, debug and calibrate Train Movement and holding Points
void testMoveRueckwaerts() {
    server.send(200, "text/plain", "10 sek rueckwaerts");
    myTrainHub.setLedColor(RED);
    delay(1000);
    myTrainHub.setMotorSpeed(_port, -35);
    delay(10000);
    myTrainHub.stopMotor(_port);   
}
void testMoveVorwaerts() {
    server.send(200, "text/plain", "10 sek vorwaerts");
    myTrainHub.setLedColor(RED);
    delay(1000);
    myTrainHub.setMotorSpeed(_port, 35);
    delay(10000);
    myTrainHub.stopMotor(_port);    
}

//Main Method
void fillingTank() {
  while(true) {
    fullValue = analogRead(waterSensorFull);
  emptyValue = analogRead(waterSensorEmpty);
  if(emptyValue >= 1000 && fullValue >= 1000) {
    Serial.println("Full");
    Serial.println("Sensor Full: ");
    Serial.println(fullValue);
    Serial.println("Sensor Empty: ");
    Serial.println(emptyValue);
    break;
  } else if(emptyValue >= 1000 && fullValue <= 1000) {
    Serial.println("In between filled");
    Serial.println("Sensor Full: ");
    Serial.println(fullValue);
    Serial.println("Sensor Empty: ");
    Serial.println(emptyValue);
  } else if(emptyValue <= 1000 && fullValue <= 1000) {
    Serial.println("Empty");
    Serial.println("Sensor Full: ");
    Serial.println(fullValue);
    Serial.println("Sensor Empty: ");
    Serial.println(emptyValue);
  }
  delay(500);
  }
}  

void handleRoot() {
  digitalWrite(led, 1);
  server.send(200, "text/plain", "Hydrogentrain is online!");
  digitalWrite(led, 0);
}

void handleNotFound() {
  digitalWrite(led, 1);
  String message = "File Not Found\n\n";
  message += "URI: ";
  message += server.uri();
  message += "\nMethod: ";
  message += (server.method() == HTTP_GET) ? "GET" : "POST";
  message += "\nArguments: ";
  message += server.args();
  message += "\n";
  for (uint8_t i = 0; i < server.args(); i++) {
    message += " " + server.argName(i) + ": " + server.arg(i) + "\n";
  }
  server.send(404, "text/plain", message);
  digitalWrite(led, 0);
}

void setup(void) {
  pinMode(led, OUTPUT);
  digitalWrite(led, 0);
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.println("");
  lcd.init();
  lcd.backlight(); //Hintergrundbeleuchtung einschalten (lcd.noBacklight(); schaltet die Beleuchtung aus). 
  lcd.setCursor(0, 0);
  lcd.print("Connecting Wifi");
  delay(100); 
  lcd.setCursor(0, 0);
  int retry = 0;
  // Wait for connection
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    retry = retry + 1;
    if(retry >= 60){
      ESP.restart();
    }
  }
  retry = 0;
  Serial.println("");
  Serial.print("Connected to ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("HydrogenTrain")) {
    Serial.println("MDNS responder started");
  }

  server.on("/", handleRoot);

  //server.on("/fillingTank", fillingTank);

  server.on("/testmovevorwaerts", testMoveVorwaerts);

  server.on("/testmoverueckwaerts", testMoveRueckwaerts);

  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP server started");

  lcd.setCursor(0, 0);
  lcd.print("Connecting BLE ");
  delay(200);
  lcd.setCursor(0, 0);
  
  myTrainHub.init(); // initalize the PoweredUpHub instance
  while(true) {
    if (myTrainHub.isConnecting()) {
      myTrainHub.connectHub();
      if (myTrainHub.isConnected()) {
        Serial.println("Connected to HUB");
        break;
      }
    }
  }
  
  lcd.setCursor(0, 0);
  lcd.print("Hydrogen Train"); 
  lcd.setCursor(0, 1);
  lcd.print(WiFi.localIP()); 
}

/*-------------------------------------------Main loop-------------------------------------------------*/

void loop(void) {
  server.handleClient();
}
