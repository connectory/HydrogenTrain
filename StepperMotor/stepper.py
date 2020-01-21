import RPi.GPIO as GPIO
import sys

from time import sleep
import os

GPIO.setmode(GPIO.BCM)

# Verwendete Pins des ULN2003A auf die Pins des Rapberry Pi
# zugeordnet
IN1 = 6  # IN1
IN2 = 13  # IN2
IN3 = 19  # IN3
IN4 = 26  # IN4

# Wartezeit regelt die Geschwindigkeit wie schnell sich der Motor
# dreht.
time = 0.002


GPIO.setup(IN1, GPIO.OUT)
GPIO.setup(IN2, GPIO.OUT)
GPIO.setup(IN3, GPIO.OUT)
GPIO.setup(IN4, GPIO.OUT)

GPIO.output(IN1, False)
GPIO.output(IN2, False)
GPIO.output(IN3, False)
GPIO.output(IN4, False)


def Step1():
    GPIO.output(IN4, True)
    sleep(time)
    GPIO.output(IN4, False)


def Step2():
    GPIO.output(IN4, True)
    GPIO.output(IN3, True)
    sleep(time)
    GPIO.output(IN4, False)
    GPIO.output(IN3, False)


def Step3():
    GPIO.output(IN3, True)
    sleep(time)
    GPIO.output(IN3, False)


def Step4():
    GPIO.output(IN2, True)
    GPIO.output(IN3, True)
    sleep(time)
    GPIO.output(IN2, False)
    GPIO.output(IN3, False)


def Step5():
    GPIO.output(IN2, True)
    sleep(time)
    GPIO.output(IN2, False)


def Step6():
    GPIO.output(IN1, True)
    GPIO.output(IN2, True)
    sleep(time)
    GPIO.output(IN1, False)
    GPIO.output(IN2, False)


def Step7():
    GPIO.output(IN1, True)
    sleep(time)
    GPIO.output(IN1, False)


def Step8():
    GPIO.output(IN4, True)
    GPIO.output(IN1, True)
    sleep(time)
    GPIO.output(IN4, False)
    GPIO.output(IN1, False)


# Umdrehung links herum
def left(step):
    for i in range(step):
        # os.system('clear') # verlangsamt die Bewegung des Motors zu sehr.
        Step1()
        Step2()
        Step3()
        Step4()
        Step5()
        Step6()
        Step7()
        Step8()



# Umdrehung rechts herum
def right(step):
    for i in range(step):
        # os.system('clear') # verlangsamt die Bewegung des Motors zu sehr.
        Step8()
        Step7()
        Step6()
        Step5()
        Step4()
        Step3()
        Step2()
        Step1()

            
if __name__ == '__main__':
    steps = sys.argv[2]
    if sys.argv[1] == 'forward':
        left(int(steps))
        print("done left")
        GPIO.cleanup()
    elif sys.argv[1] == 'backward':
        right(int(steps))
        print("done right")
        GPIO.cleanup()
    else:
        raise Exception("argument not valid", sys.argv[1])
