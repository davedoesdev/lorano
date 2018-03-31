#include <Sodaq_RN2483.h>

#define debugSerial SerialUSB
#define loraSerial Serial2

#define NIBBLE_TO_HEX_CHAR(i) ((i <= 9) ? ('0' + i) : ('A' - 10 + i))
#define HIGH_NIBBLE(i) ((i >> 4) & 0x0F)
#define LOW_NIBBLE(i) (i & 0x0F)

// This will be filled in with the HWEUI
static uint8_t DevEUI[8]
{
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// USE YOUR OWN KEYS!
const uint8_t AppEUI[8] =
{
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// USE YOUR OWN KEYS!
const uint8_t AppKey[16] =
{
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// 6 bytes of our random data + 6 bytes of their random data
const size_t payload_size = 12;
uint8_t recv_payload[payload_size];

void setup()
{
  while ((!debugSerial) && (millis() < 10000));
  
  debugSerial.begin(57600);
  loraSerial.begin(LoRaBee.getDefaultBaudRate());

  LoRaBee.setDiag(debugSerial); // optional
  LoRaBee.init(loraSerial);

  //Use the Hardware EUI
  LoRaBee.getHWEUI(DevEUI, sizeof(DevEUI));

   // Print the Hardware EUI
  debugSerial.print("LoRa HWEUI: ");
  for (uint8_t i = 0; i < sizeof(DevEUI); i++) {
    debugSerial.print((char)NIBBLE_TO_HEX_CHAR(HIGH_NIBBLE(DevEUI[i])));
    debugSerial.print((char)NIBBLE_TO_HEX_CHAR(LOW_NIBBLE(DevEUI[i])));
  }
  debugSerial.println(); 
    
  while (!LoRaBee.initOTA(loraSerial, DevEUI, AppEUI, AppKey, false))
  {
    debugSerial.println("Connection to the network failed!");
    delay(60000);
  }
  debugSerial.println("Connection to the network was successful.");

  randomSeed(analogRead(0));
}

#include <stdarg.h>
void p(char *fmt, ... ){
  char buf[128]; // resulting string limited to 128 chars
  va_list args;
  va_start (args, fmt );
  vsnprintf(buf, 128, fmt, args);
  va_end (args);
  debugSerial.print(buf);
}

void loop()
{
  uint8_t send_payload[payload_size];
  // Fill our random data
  for (size_t i = 0; i < payload_size/2; i++)
  {
    send_payload[i] = random(256);
  }
  // Fill their random data. First time round this won't match what
  // they're expecting but they should just ignore it and send their packet.
  for (size_t i = payload_size/2; i < payload_size; i++)
  {
    send_payload[i] = recv_payload[i];
    //p("%02x %02x ", i, recv_payload[i]);
  }
  //debugSerial.println("");

  // Send packet
  uint8_t status = LoRaBee.send(1, send_payload, sizeof(send_payload));
  if (status != NoError)
  {
    p("Error sending payload: %d\n", status);
    return;
  }
  debugSerial.println("Sent packet");

  for (uint8_t i = 0; i < 60; i++)
  {
    // Receive packet
    uint8_t n = LoRaBee.receive(recv_payload, sizeof(recv_payload));
    //p("Received %d bytes\n", n);

    // Check if we got back our data
    if ((n == sizeof(recv_payload)) &&
        (memcmp(recv_payload, send_payload, payload_size/2) == 0))
    {
      debugSerial.println("Received matching packet");
      break;      
    }
    //debugSerial.println("No matching bytes received");
    delay(1000);
  }
}
