// Run the actual tracking/GSM C++ on an emulated AVR. Fixtures never enter production.
const fs=require('fs'), path=require('path'), cp=require('child_process');
const {CPU,avrInstruction}=require('../.build/node_modules/avr8js');
const bin=process.env.AVR_BIN || 'C:/Users/PC/AppData/Local/Arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin';
const run=(name,args)=>cp.execFileSync(path.join(bin,name+'.exe'),args,{encoding:'utf8'});
const elf='.build/tracking-test.elf', hex='.build/tracking-test.hex';
run('avr-g++',['-std=c++11','-Wall','-Wextra','-Werror','-Os','-mmcu=atmega2560','tests/tracking_firmware_test.cpp','-lm','-o',elf]);
run('avr-objcopy',['-O','ihex',elf,hex]);
const symbols=run('avr-nm',['-n',elf]);
const match=symbols.match(/^([0-9a-f]+)\s+\w\s+testResult$/m);
if(!match)throw Error('Missing test result symbol');
const address=parseInt(match[1],16)-0x800000;
const bytes=new Uint8Array(256*1024);
let upper=0;
for(const line of fs.readFileSync(hex,'utf8').trim().split(/\r?\n/)){
  const length=parseInt(line.slice(1,3),16), offset=parseInt(line.slice(3,7),16), type=parseInt(line.slice(7,9),16);
  if(type===4)upper=parseInt(line.slice(9,13),16)*65536;
  if(type===0)for(let i=0;i<length;i++)bytes[upper+offset+i]=parseInt(line.slice(9+i*2,11+i*2),16);
}
const cpu=new CPU(new Uint16Array(bytes.buffer),0x2200);
let result=0;
for(let i=0;i<30000000;i++){
  avrInstruction(cpu);cpu.tick();
  result=cpu.data[address]|cpu.data[address+1]<<8;
  if(result){for(let settle=0;settle<20;settle++){avrInstruction(cpu);cpu.tick();}result=cpu.data[address]|cpu.data[address+1]<<8;break;}
}
if(result!==65535)throw Error(result?`Firmware assertion failed at line ${result}`:'Firmware execution timed out');
console.log('PASS: actual C++ empty/stationary/jitter; 0.3/0.7 m; toward/away qualification; stale cleanup; jump/reversal/crossing; slot reassociation; GSM message/submission/anti-spam');
