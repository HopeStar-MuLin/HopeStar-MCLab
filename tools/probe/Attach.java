import com.sun.tools.attach.VirtualMachine;

/** java Attach <pid> <agent.jar> <output.txt> */
public final class Attach {
    public static void main(String[] args) throws Exception {
        VirtualMachine vm = VirtualMachine.attach(args[0]);
        try {
            vm.loadAgent(args[1], args[2]);
        } finally {
            vm.detach();
        }
        System.out.println("attached to " + args[0] + ", output -> " + args[2]);
    }
}
