#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>

//LCB Screen init
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);

//Lego Train BLE init
#include "src/PoweredUpHub.h"

//Farbsensor init
#define S0 5
#define S1 23
#define S2 18
#define S3 26
#define sensorOut 19

/*----------------------------------------Train Variables---------------------------------------------*/
//Lego Train BLE
PoweredUpHub myTrainHub;
PoweredUpHub::Port _port = PoweredUpHub::Port::A;

//Color Sensor
int rfrequency = 0;
int gfrequency = 0;
int bfrequency = 0;

//Wifi Credentials
const char* ssid = "Connectory Hackathon I";
const char* password = "connectory2019";

//Water Sensor
const int waterSensorFull = 2;
const int waterSensorEmpty = 0;
int fullValue = 0;
int emptyValue = 0;
int lastStopSignal = 0; //0 = No Signal, 1 = Yellow Signal, 2 = Red Signal

/*----------------------------------------Wifi Setup--------------------------------------------------*/

WebServer server(80);

const int led = 13;


/*-------------------------------------------Train Methods---------------------------------------------*/

//Test to check, debug and calibrate Train Movement and holding Points
void testMove() {
    myTrainHub.setLedColor(RED);
    delay(1000);
    myTrainHub.setMotorSpeed(_port, 35);
    delay(10000);
    myTrainHub.stopMotor(_port);    
}

//Main Method
void fillingTank() {
  /*while(true) {
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
  }*/

  myTrainHub.setLedColor(RED);
  delay(1000);
  myTrainHub.setMotorSpeed(_port, 35);

  while(true) {
    // Setting red filtered photodiodes to be read
    digitalWrite(S2,LOW);
    digitalWrite(S3,LOW);
    // Reading the output frequency
    rfrequency = pulseIn(sensorOut, LOW);
    //Remaping the value of the frequency to the RGB Model of 0 to 255
    rfrequency = map(rfrequency, 25,72,255,0);
  
    // Setting Green filtered photodiodes to be read
    digitalWrite(S2,HIGH);
    digitalWrite(S3,HIGH);
    // Reading the output frequency
    gfrequency = pulseIn(sensorOut, LOW);
    //Remaping the value of the frequency to the RGB Model of 0 to 255
    gfrequency = map(gfrequency, 30,90,255,0);
  
    // Setting Blue filtered photodiodes to be read
    digitalWrite(S2,LOW);
    digitalWrite(S3,HIGH);
    // Reading the output frequency
    bfrequency = pulseIn(sensorOut, LOW);
    //Remaping the value of the frequency to the RGB Model of 0 to 255
    bfrequency = map(bfrequency, 25,70,255,0);
  
    if(rfrequency >= 200 && gfrequency >= 100 && bfrequency <= 175) {
      if(lastStopSignal == 1) {
        myTrainHub.setMotorSpeed(_port, 20);  
        lastStopSignal = 0;
      }
      else {
        lastStopSignal = 1;
      }
    } else if(rfrequency >= 125 && gfrequency <= 100 &&bfrequency <= 50 ) {
      if(lastStopSignal == 2) {
        myTrainHub.stopMotor(_port);
        break;
      }
      else {
        lastStopSignal = 2;
      }
    }
    else {
      lastStopSignal = 0;
    }
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
  //Color Sensor 
  pinMode(S0, OUTPUT);
  pinMode(S1, OUTPUT);
  pinMode(S2, OUTPUT);
  pinMode(S3, OUTPUT);
  pinMode(sensorOut, INPUT);
  digitalWrite(S0,HIGH);
  digitalWrite(S1,LOW);

  //Wifi
  pinMode(led, OUTPUT);
  digitalWrite(led, 0);
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.println("");

  //LCD Screen
  lcd.init();
  lcd.backlight(); //Hintergrundbeleuchtung einschalten (lcd.noBacklight(); schaltet die Beleuchtung aus). 
  lcd.setCursor(0, 0);
  lcd.print("Connecting Wifi..."); 

  // Wait for connection
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.print("Connected to ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin("HydrogenTrain")) {
    Serial.println("MDNS responder started");
  }

  server.on("/", handleRoot);

  server.on("/fillingTank", fillingTank);

  server.on("/testMove", testMove);

  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP server started");

  lcd.print("Connecting BLE...");
  
  myTrainHub.init(); // initalize the PoweredUpHub instance
  while(true) {
    if (myTrainHub.isConnecting()) {
      myTrainHub.connectHub();
      if (myTrainHub.isConnected()) {
        Serial.println("Connected to HUB");
        break;
      } else {
        Serial.println("Failed to connect to HUB");
      }
    }
  }
  
  lcd.setCursor(0, 0);
  lcd.print("Hydrogen Train"); 
  lcd.setCursor(0, 1);
  lcd.print("Company XYZ"); 
}

/*-------------------------------------------Main loop-------------------------------------------------*/

void loop(void) {
  server.handleClient();
}
